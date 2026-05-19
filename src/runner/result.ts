export type RunStatus = "succeeded" | "failed";

/**
 * Why a run terminated.
 *
 * - `terminal_node_succeeded` — a `terminal: true` node completed with
 *   `succeeded`.
 * - `node_failed` — a node failed and no `on_failure` outbound edge was
 *   traversable (either because none exist or every one was budget-exhausted).
 * - `budget_exhausted` — the queue drained after at least one budget-driven
 *   skip and no terminal node ever succeeded.
 * - `graph_drained` — the queue drained naturally (no budget hits) without a
 *   terminal node succeeding. Almost always means the factory is mis-modeled.
 * - `unknown_executor` — a node referenced an `executor` not in the registry.
 */
export type RunReason =
  | "terminal_node_succeeded"
  | "node_failed"
  | "budget_exhausted"
  | "graph_drained"
  | "unknown_executor";

export interface ExecutionLogEntry {
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  startedAt: number;
  endedAt: number;
}

export interface RunResult {
  status: RunStatus;
  reason: RunReason;
  /** Node id that caused the terminal classification, when applicable. */
  proximateNodeId?: string;
  log: ExecutionLogEntry[];
  durationMs: number;
}
