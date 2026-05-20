import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Brief } from "../brief/loader.js";
import type { ExecutorRegistry } from "../executor/registry.js";
import type { EmittedEvent, NodeResult, ResolvedNode, RunContext } from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { RunStore, StoredEventKind } from "../storage/run-store.js";
import type { ExecutionLogEntry, RunResult } from "./result.js";
import { type Substitutions, substitute } from "./substitute.js";

export interface RunOptions {
  registry: ExecutorRegistry;
  /** Called for every event yielded by any node, in order. */
  onEvent?: (entry: EmittedEvent) => void;
  /** Optional brief in scope for this run. When set, the runner substitutes
   * `{{ brief.<field> }}` tokens in each node's `with.prompt` string
   * immediately before dispatch. */
  brief?: Brief;
  /** Optional run-level cwd. When set, becomes the default cwd for any node
   * whose `cwd` field is absent or resolves to the empty string, and
   * resolves the `{{ run.cwd }}` template token. */
  runCwd?: string;
  /** Optional persistence backend. When supplied the runner records the run
   * row, every event, per-node executions, and the terminal status through
   * the store; when absent the runner behaves exactly as it does without
   * persistence. */
  store?: RunStore;
  /** Optional pre-generated run id. When omitted the runner generates one.
   * Callers (CLI, daemon) supply this so they can reference the row before
   * the runner returns. */
  runId?: string;
}

interface QueueItem {
  nodeId: string;
}

export async function runFactory(loaded: LoadedFactory, options: RunOptions): Promise<RunResult> {
  const { factory, sourceDir, sourcePath } = loaded;
  const { registry, onEvent, brief, runCwd, store } = options;
  const subs: Substitutions = {};
  if (brief) subs.brief = brief;
  if (runCwd !== undefined && runCwd.length > 0) subs.run = { cwd: runCwd };

  const runStart = Date.now();
  const runId = options.runId ?? randomUUID();
  const priorResults: NodeResult[] = [];
  const log: ExecutionLogEntry[] = [];

  if (store) {
    try {
      await store.createRun({
        id: runId,
        factoryPath: sourcePath,
        factoryName: factory.name,
        briefPath: brief?.sourcePath ?? null,
        change: brief?.frontmatter.change ?? null,
        baseBranch: brief?.frontmatter.base_branch ?? null,
        worktreePath: runCwd ?? null,
        startedAt: runStart,
      });
    } catch (err) {
      reportStoreError(onEvent, runStart, err);
    }
  }

  const appendStoreEvent = async (
    nodeId: string | null,
    iteration: number,
    kind: StoredEventKind,
    payload: unknown,
    emittedAt: number,
  ): Promise<void> => {
    if (!store) return;
    try {
      await store.appendEvent(runId, {
        nodeId,
        iteration,
        kind,
        payload,
        emittedAt,
      });
    } catch (err) {
      reportStoreError(onEvent, runStart, err);
    }
  };

  const iterations = new Map<string, number>();
  const edgeTraversals = new Map<string, number>(); // key: from|to|when
  for (const id of Object.keys(factory.nodes)) iterations.set(id, 0);

  // Track whether at least one budget hit caused a skip — used to classify
  // termination as `budget_exhausted` vs `graph_drained`.
  let budgetHit = false;

  // Start nodes = nodes with no `on_success` inbound edge. See
  // specs/graph-runner/spec.md "Start nodes".
  const onSuccessInbound = new Set<string>();
  for (const edge of factory.edges) {
    if (edge.when === "on_success") onSuccessInbound.add(edge.to);
  }
  const startNodeIds = Object.keys(factory.nodes).filter((id) => !onSuccessInbound.has(id));

  const queue: QueueItem[] = startNodeIds.map((id) => ({ nodeId: id }));

  let result: RunResult | null = null;

  const resolveCwd = (nodeCwd: string | undefined): string => {
    let effective = nodeCwd;
    if (typeof effective === "string" && effective.length > 0) {
      effective = substitute(effective, subs);
    }
    if (effective !== undefined && effective.length > 0) {
      if (path.isAbsolute(effective)) return effective;
      return path.resolve(sourceDir, effective);
    }
    if (runCwd !== undefined && runCwd.length > 0) return runCwd;
    return sourceDir;
  };

  const edgeKey = (from: string, to: string, when: string): string => `${from}|${to}|${when}`;

  while (queue.length > 0 && result === null) {
    const next = queue.shift();
    if (!next) break;
    const { nodeId } = next;
    const node = factory.nodes[nodeId];
    if (!node) continue;

    // Enforce node max_iterations at pop time too — defensive against
    // multiple successors enqueueing the same node.
    const usedIterations = iterations.get(nodeId) ?? 0;
    if (node.max_iterations !== undefined && usedIterations >= node.max_iterations) {
      budgetHit = true;
      if (store) {
        try {
          await store.recordNodeEnd(runId, nodeId, usedIterations + 1, {
            status: "skipped",
            at: Date.now(),
          });
        } catch (err) {
          reportStoreError(onEvent, runStart, err);
        }
      }
      continue;
    }

    const executor = registry.get(node.executor);
    if (!executor) {
      result = {
        status: "failed",
        reason: "unknown_executor",
        proximateNodeId: nodeId,
        log,
        durationMs: Date.now() - runStart,
      };
      break;
    }

    const iteration = usedIterations + 1;
    iterations.set(nodeId, iteration);

    if (store) {
      try {
        await store.recordNodeStart(runId, nodeId, iteration, Date.now());
      } catch (err) {
        reportStoreError(onEvent, runStart, err);
      }
    }

    let resolvedNode: ResolvedNode = { ...node, id: nodeId };
    if ((subs.brief || subs.run) && node.with && typeof node.with.prompt === "string") {
      const substituted = substitute(node.with.prompt, subs);
      resolvedNode = {
        ...resolvedNode,
        with: { ...node.with, prompt: substituted },
      };
    }
    const snapshot: readonly NodeResult[] = Object.freeze(priorResults.slice());

    const ctx: RunContext = {
      factory,
      priorResults: snapshot,
      nodeId,
      iteration,
      cwd: resolveCwd(node.cwd),
    };

    const startedAt = Date.now() - runStart;
    let finalStatus: "succeeded" | "failed" | null = null;
    let terminalMeta: unknown = undefined;

    for await (const event of executor.run(resolvedNode, ctx)) {
      const emittedAt = Date.now() - runStart;
      const entry: EmittedEvent = {
        nodeId,
        iteration,
        emittedAt,
        event,
      };
      onEvent?.(entry);
      await appendStoreEvent(nodeId, iteration, event.kind, event, emittedAt);

      if (event.kind === "status") {
        if (event.status === "succeeded" || event.status === "failed") {
          finalStatus = event.status;
          terminalMeta = event.meta;
        }
      }
    }

    const endedAt = Date.now() - runStart;

    if (finalStatus === null) {
      // Executor failed to yield a terminal status. Treat as failure.
      finalStatus = "failed";
    }

    log.push({ nodeId, iteration, status: finalStatus, startedAt, endedAt });

    // Append a NodeResult entry for this execution. The reason is captured
    // from the terminal status event's `meta.sentinel` field when the
    // executor reports `meta.reason === "sentinel_failed"`; otherwise null.
    priorResults.push({
      nodeId,
      iteration,
      status: finalStatus,
      reason: extractReason(finalStatus, terminalMeta),
      startedAt,
      endedAt,
    });

    if (store) {
      try {
        await store.recordNodeEnd(runId, nodeId, iteration, {
          status: finalStatus,
          at: Date.now(),
        });
      } catch (err) {
        reportStoreError(onEvent, runStart, err);
      }
    }

    if (finalStatus === "succeeded" && node.terminal) {
      result = {
        status: "succeeded",
        reason: "terminal_node_succeeded",
        proximateNodeId: nodeId,
        log,
        durationMs: Date.now() - runStart,
      };
      break;
    }

    // Evaluate outbound edges.
    const outbound = factory.edges.filter((e) => e.from === nodeId);
    let traversedAny = false;
    let skippedDueToBudget = false;
    for (const edge of outbound) {
      const matchesWhen =
        (finalStatus === "succeeded" && edge.when === "on_success") ||
        (finalStatus === "failed" && edge.when === "on_failure");
      if (!matchesWhen) continue;

      const key = edgeKey(edge.from, edge.to, edge.when);
      const used = edgeTraversals.get(key) ?? 0;
      if (edge.max_traversals !== undefined && used >= edge.max_traversals) {
        skippedDueToBudget = true;
        budgetHit = true;
        continue;
      }

      const succ = factory.nodes[edge.to];
      if (succ?.max_iterations !== undefined) {
        const succUsed = iterations.get(edge.to) ?? 0;
        if (succUsed >= succ.max_iterations) {
          skippedDueToBudget = true;
          budgetHit = true;
          continue;
        }
      }

      edgeTraversals.set(key, used + 1);
      queue.push({ nodeId: edge.to });
      traversedAny = true;
    }

    if (finalStatus === "failed" && !traversedAny) {
      result = {
        status: "failed",
        reason: skippedDueToBudget ? "budget_exhausted" : "node_failed",
        proximateNodeId: nodeId,
        log,
        durationMs: Date.now() - runStart,
      };
      break;
    }
  }

  if (result === null) {
    result = {
      status: "failed",
      reason: budgetHit ? "budget_exhausted" : "graph_drained",
      log,
      durationMs: Date.now() - runStart,
    };
  }

  if (store) {
    try {
      await store.finalizeRun(runId, {
        status: result.status,
        reason: result.reason,
        proximateNodeId: result.proximateNodeId ?? null,
        endedAt: Date.now(),
      });
    } catch (err) {
      reportStoreError(onEvent, runStart, err);
    }
  }

  return result;
}

function extractReason(status: "succeeded" | "failed", meta: unknown): string | null {
  if (status !== "failed") return null;
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { reason?: unknown; sentinel?: unknown };
  if (m.reason !== "sentinel_failed") return null;
  if (typeof m.sentinel !== "string") return null;
  return m.sentinel.replace(/\s+$/, "");
}

function reportStoreError(
  onEvent: ((entry: EmittedEvent) => void) | undefined,
  runStart: number,
  err: unknown,
): void {
  // Surface store failures as a synthetic stderr event via the streaming
  // callback. Do NOT append to priorResults — that array is for real node
  // executions only.
  const entry: EmittedEvent = {
    nodeId: "__store__",
    iteration: 0,
    emittedAt: Date.now() - runStart,
    event: {
      kind: "stderr",
      line: `store error: ${(err as Error).message}`,
    },
  };
  onEvent?.(entry);
}
