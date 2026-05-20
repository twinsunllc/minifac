import path from "node:path";
import type { Brief } from "../brief/loader.js";
import type { ExecutorRegistry } from "../executor/registry.js";
import type { NodeEvent, ResolvedNode, RunContext, RunHistoryEntry } from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { ExecutionLogEntry, RunResult } from "./result.js";
import { substituteBriefTokens } from "./substitute.js";

export interface RunOptions {
  registry: ExecutorRegistry;
  /** Called for every event yielded by any node, in order. */
  onEvent?: (entry: RunHistoryEntry) => void;
  /** Optional brief in scope for this run. When set, the runner substitutes
   * `{{ brief.<field> }}` tokens in each node's `with.prompt` string
   * immediately before dispatch. */
  brief?: Brief;
}

interface QueueItem {
  nodeId: string;
}

export async function runFactory(loaded: LoadedFactory, options: RunOptions): Promise<RunResult> {
  const { factory, sourceDir } = loaded;
  const { registry, onEvent, brief } = options;

  const runStart = Date.now();
  const history: RunHistoryEntry[] = [];
  const log: ExecutionLogEntry[] = [];

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
    if (!nodeCwd) return sourceDir;
    if (path.isAbsolute(nodeCwd)) return nodeCwd;
    return path.resolve(sourceDir, nodeCwd);
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

    // Build a shallow-cloned node for dispatch so we never mutate the
    // factory's node objects (they're reused across iterations). When a brief
    // is in scope and the node has a string `with.prompt`, substitute brief
    // tokens before handing the node to the executor.
    let resolvedNode: ResolvedNode = { ...node, id: nodeId };
    if (brief && node.with && typeof node.with.prompt === "string") {
      const substituted = substituteBriefTokens(node.with.prompt, brief);
      resolvedNode = {
        ...resolvedNode,
        with: { ...node.with, prompt: substituted },
      };
    }
    const snapshot: readonly RunHistoryEntry[] = Object.freeze(history.slice());

    const ctx: RunContext = {
      factory,
      history: snapshot,
      nodeId,
      iteration,
      cwd: resolveCwd(node.cwd),
    };

    const startedAt = Date.now() - runStart;
    let finalStatus: "succeeded" | "failed" | null = null;

    for await (const event of executor.run(resolvedNode, ctx)) {
      const entry: RunHistoryEntry = {
        nodeId,
        iteration,
        emittedAt: Date.now() - runStart,
        event,
      };
      history.push(entry);
      onEvent?.(entry);

      if (event.kind === "status") {
        if (event.status === "succeeded" || event.status === "failed") {
          finalStatus = event.status;
        }
      }
    }

    const endedAt = Date.now() - runStart;

    if (finalStatus === null) {
      // Executor failed to yield a terminal status. Treat as failure.
      finalStatus = "failed";
    }

    log.push({ nodeId, iteration, status: finalStatus, startedAt, endedAt });

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

      // Also skip if successor has exhausted its node iteration budget — we
      // could enqueue + drop at pop time, but eagerly checking gives a more
      // accurate "graph drained vs budget hit" classification.
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
      // No recovery available.
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

  return result;
}
