import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Brief } from "../brief/loader.js";
import type { ExecutorRegistry } from "../executor/registry.js";
import type { EmittedEvent, NodeResult, ResolvedNode, RunContext } from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { NodeOutputIndex } from "../factory/schema.js";
import type { RunStore, StoredEventKind } from "../storage/run-store.js";
import { minifacHome } from "../worktree/config.js";
import { markBriefDone } from "./mark-done.js";
import { validateDeclaredOutputs } from "./outputs.js";
import type { ExecutionLogEntry, RunResult } from "./result.js";
import { type Substitutions, TemplateSubstitutionError, substitute } from "./substitute.js";

export interface RunOptions {
  registry: ExecutorRegistry;
  /** Called for every event yielded by any node, in order. */
  onEvent?: (entry: EmittedEvent) => void;
  /** Optional brief in scope for this run. */
  brief?: Brief;
  /** Optional run-level cwd. */
  runCwd?: string;
  /** Optional persistence backend. */
  store?: RunStore;
  /** Optional pre-generated run id. */
  runId?: string;
  /** Optional branch name to persist on the runs DB row. */
  branchName?: string;
  /** Optional cancellation signal. */
  abortSignal?: AbortSignal;
}

interface QueueItem {
  nodeId: string;
}

export async function runFactory(loaded: LoadedFactory, options: RunOptions): Promise<RunResult> {
  const { factory, sourceDir, sourcePath } = loaded;
  const { registry, onEvent, brief, runCwd, store } = options;
  const baseSubs: Substitutions = {};
  if (brief) baseSubs.brief = brief;
  if (runCwd !== undefined && runCwd.length > 0) baseSubs.run = { cwd: runCwd };

  const runStart = Date.now();
  const runId = options.runId ?? randomUUID();
  const priorResults: NodeResult[] = [];
  const log: ExecutionLogEntry[] = [];
  const outputsRoot = path.join(minifacHome(), "outputs", runId);

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
        branchName: options.branchName ?? null,
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
  const edgeTraversals = new Map<string, number>();
  for (const id of Object.keys(factory.nodes)) iterations.set(id, 0);

  let budgetHit = false;

  const onSuccessInbound = new Set<string>();
  for (const edge of factory.edges) {
    if (edge.when === "on_success") onSuccessInbound.add(edge.to);
  }
  const startNodeIds = Object.keys(factory.nodes).filter((id) => !onSuccessInbound.has(id));

  const queue: QueueItem[] = startNodeIds.map((id) => ({ nodeId: id }));

  let result: RunResult | null = null;

  const resolveCwd = (
    nodeCwd: string | undefined,
    nodeInputs: Record<string, unknown> | undefined,
    outputsDir: string,
  ): string => {
    let effective = nodeCwd;
    if (typeof effective === "string" && effective.length > 0) {
      const localSubs: Substitutions = { ...baseSubs };
      if (nodeInputs !== undefined) localSubs.inputs = nodeInputs;
      localSubs.run = { ...(baseSubs.run ?? {}), outputsDir };
      effective = substitute(effective, localSubs);
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
    if (options.abortSignal?.aborted) {
      result = {
        status: "failed",
        reason: "user_quit",
        log,
        durationMs: Date.now() - runStart,
      };
      break;
    }
    const next = queue.shift();
    if (!next) break;
    const { nodeId } = next;
    const node = factory.nodes[nodeId];
    if (!node) continue;

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

    const executorType = node.executor ?? "";
    const executor = registry.get(executorType);
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

    // Per-node-per-iteration outputs directory. Created mkdirp before
    // dispatch so the executor (and `{{ run.outputs_dir }}` token) can
    // rely on its existence.
    const outputsDir = path.join(outputsRoot, nodeId, String(iteration));
    try {
      await mkdir(outputsDir, { recursive: true, mode: 0o755 });
    } catch (err) {
      reportStoreError(onEvent, runStart, err);
    }

    if (store) {
      try {
        await store.recordNodeStart(runId, nodeId, iteration, Date.now());
      } catch (err) {
        reportStoreError(onEvent, runStart, err);
      }
    }

    const nodeInputs = (node as { __inputs?: unknown }).__inputs;
    const inputsMap =
      nodeInputs !== undefined &&
      nodeInputs !== null &&
      typeof nodeInputs === "object" &&
      !Array.isArray(nodeInputs)
        ? (nodeInputs as Record<string, unknown>)
        : undefined;

    // Build the per-node Substitutions, including outputsDir and the
    // priorResults map (latest entry per nodeId wins).
    const priorMap = new Map<string, NodeResult>();
    for (const entry of priorResults) {
      priorMap.set(entry.nodeId, entry);
    }
    const nodeSubs: Substitutions = { ...baseSubs };
    nodeSubs.run = { ...(baseSubs.run ?? {}), outputsDir };
    if (inputsMap !== undefined) nodeSubs.inputs = inputsMap;
    nodeSubs.priorResults = priorMap;

    let resolvedNode: ResolvedNode = { ...node, id: nodeId };
    if (node.with && typeof node.with.prompt === "string") {
      try {
        const substituted = substitute(node.with.prompt, nodeSubs);
        resolvedNode = {
          ...resolvedNode,
          with: { ...node.with, prompt: substituted },
        };
      } catch (err) {
        if (err instanceof TemplateSubstitutionError) {
          // Surface the error and fail the run cleanly.
          const entry: EmittedEvent = {
            nodeId,
            iteration,
            emittedAt: Date.now() - runStart,
            event: { kind: "stderr", line: `template substitution error: ${err.message}` },
          };
          onEvent?.(entry);
          await appendStoreEvent(nodeId, iteration, "stderr", entry.event, entry.emittedAt);
          if (store) {
            try {
              await store.recordNodeEnd(runId, nodeId, iteration, {
                status: "failed",
                at: Date.now(),
              });
            } catch (err2) {
              reportStoreError(onEvent, runStart, err2);
            }
          }
          result = {
            status: "failed",
            reason: "node_failed",
            proximateNodeId: nodeId,
            log,
            durationMs: Date.now() - runStart,
          };
          break;
        }
        throw err;
      }
    }
    const snapshot: readonly NodeResult[] = Object.freeze(priorResults.slice());

    const ctx: RunContext = {
      factory,
      priorResults: snapshot,
      nodeId,
      iteration,
      cwd: resolveCwd(node.cwd, inputsMap, outputsDir),
      outputsDir,
    };

    const startedAt = Date.now() - runStart;
    let finalStatus: "succeeded" | "failed" | null = null;
    let terminalMeta: unknown = undefined;

    let aborted = false;
    for await (const event of executor.run(resolvedNode, ctx)) {
      if (options.abortSignal?.aborted) {
        aborted = true;
        break;
      }
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
    if (aborted) {
      result = {
        status: "failed",
        reason: "user_quit",
        proximateNodeId: nodeId,
        log,
        durationMs: Date.now() - runStart,
      };
      break;
    }

    const endedAt = Date.now() - runStart;

    if (finalStatus === null) {
      finalStatus = "failed";
    }

    log.push({ nodeId, iteration, status: finalStatus, startedAt, endedAt });

    // Post-execution outputs validation. Runs only when the node:
    //  - declared an `outputs:` block, AND
    //  - terminated `succeeded`.
    // Sentinel-failed and other-failed nodes skip validation; their
    // `NodeResult.outputs` stays null.
    let outputsForResult: NodeOutputIndex | null = null;
    let resultReason: string | null = extractReason(finalStatus, terminalMeta);
    let validatedIndex: NodeOutputIndex = {};
    if (finalStatus === "succeeded" && node.outputs) {
      const validation = await validateDeclaredOutputs(node, outputsDir);
      validatedIndex = validation.index;
      if (validation.missing.length > 0) {
        finalStatus = "failed";
        resultReason = "missing_required_output";
        // Surface the override on stderr so operators see what happened.
        const lines: string[] = [];
        lines.push(
          `missing_required_output: node "${nodeId}" succeeded but is missing required outputs: ${validation.missing.join(", ")} (dir: ${outputsDir})`,
        );
        for (const key of validation.missing) {
          const d = validation.detail[key];
          if (d) lines.push(`  - ${d}`);
        }
        for (const line of lines) {
          const entry: EmittedEvent = {
            nodeId,
            iteration,
            emittedAt: Date.now() - runStart,
            event: { kind: "stderr", line },
          };
          onEvent?.(entry);
          await appendStoreEvent(nodeId, iteration, "stderr", entry.event, entry.emittedAt);
        }
        // Re-emit a status event so consumers can observe the override.
        const statusEvent: EmittedEvent = {
          nodeId,
          iteration,
          emittedAt: Date.now() - runStart,
          event: {
            kind: "status",
            status: "failed",
            meta: {
              reason: "missing_required_output",
              missing_outputs: validation.missing,
              missing_outputs_detail: validation.detail,
              outputs_dir: outputsDir,
              partial_index: validation.index,
            },
          },
        };
        onEvent?.(statusEvent);
        await appendStoreEvent(
          nodeId,
          iteration,
          "status",
          statusEvent.event,
          statusEvent.emittedAt,
        );
        // outputs on the prior-results snapshot is null when overridden.
        outputsForResult = null;
      } else {
        outputsForResult = Object.keys(validation.index).length > 0 ? validation.index : null;
      }
    }

    priorResults.push({
      nodeId,
      iteration,
      status: finalStatus,
      reason: resultReason,
      startedAt,
      endedAt,
      outputs: outputsForResult,
    });

    // Persist any indexed outputs (including the partial index on override)
    // BEFORE recordNodeEnd so the storage state is consistent.
    if (store && Object.keys(validatedIndex).length > 0) {
      try {
        await store.recordNodeOutputs(runId, nodeId, iteration, validatedIndex);
      } catch (err) {
        reportStoreError(onEvent, runStart, err);
      }
    }

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

  if (result.status === "succeeded" && brief && runCwd !== undefined && runCwd.length > 0) {
    const change = brief.frontmatter.change;
    if (typeof change === "string" && change.length > 0) {
      try {
        const markRes = await markBriefDone({ change, runCwd });
        if (markRes.warning) {
          const entry: EmittedEvent = {
            nodeId: "__mark_done__",
            iteration: 0,
            emittedAt: Date.now() - runStart,
            event: { kind: "stderr", line: markRes.warning },
          };
          onEvent?.(entry);
        }
      } catch (err) {
        const entry: EmittedEvent = {
          nodeId: "__mark_done__",
          iteration: 0,
          emittedAt: Date.now() - runStart,
          event: {
            kind: "stderr",
            line: `mark-done: unexpected error: ${(err as Error).message}`,
          },
        };
        onEvent?.(entry);
      }
    }
  }

  if (store) {
    try {
      // Invariant: `finalizeRun` MUST resolve before the caller releases the
      // per-change lockfile. See `worktree-management` capability,
      // "Runner finalizes runs.db status before releasing the per-change
      // lockfile" — the orphan-probe in `auto-mode` relies on it. Callers
      // (e.g. `runBriefAutomated`) hold the lock for the whole life of
      // `runFactory` and unlink in `finally`, so awaiting here is what
      // makes the ordering load-bearing.
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
