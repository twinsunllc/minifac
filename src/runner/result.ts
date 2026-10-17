import type { NodeOutcome } from "../executor/types.js";

/**
 * `parked` is neither: the run stopped at a node boundary because the
 * caller's `onNodeBoundary` hook asked it to, and it can be resumed at the
 * undispatched node (ADR 0048).
 */
export type RunStatus = "succeeded" | "failed" | "parked";

/**
 * Why a run terminated.
 *
 * - `terminal_node_succeeded` — a `terminal: true` node completed with
 *   `succeeded`.
 * - `node_failed` — a node failed or errored and declares no outbound edge
 *   for its outcome (when it declares some and every one is budget-exhausted,
 *   the reason is `budget_exhausted`). See ADR 0052 for which edges an
 *   errored node takes.
 * - `budget_exhausted` — the queue drained after at least one budget-driven
 *   skip and no terminal node ever succeeded.
 * - `graph_drained` — the queue drained naturally (no budget hits) without a
 *   terminal node succeeding. Almost always means the factory is mis-modeled.
 * - `unknown_executor` — a node referenced an `executor` not in the registry.
 * - `resume_unknown_node` — a run was asked to resume at a node the factory
 *   does not declare. Nothing is dispatched: seeding a run at a node nobody
 *   named would run an arbitrary node against a human's answer.
 * - `user_quit` — the caller's `abortSignal` fired.
 * - `parked` — the caller's `onNodeBoundary` hook returned `"park"` for the
 *   next dispatch, so the run ended without dispatching it. Always paired
 *   with `status: "parked"` and a `parked` payload (ADR 0048).
 */
export type RunReason =
  | "terminal_node_succeeded"
  | "node_failed"
  | "budget_exhausted"
  | "graph_drained"
  | "unknown_executor"
  | "resume_unknown_node"
  | "user_quit"
  | "parked";

export interface ExecutionLogEntry {
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  /** `success`, a judged `failure`, or an `error` (ADR 0052). */
  outcome: NodeOutcome;
  startedAt: number;
  endedAt: number;
}

/**
 * Where a parked run stopped (ADR 0048): everything a caller needs to resume
 * it at the undispatched node with `ResumeState { reason: "pause" }`.
 */
export interface ParkedRun {
  /** The node that was about to be dispatched and was not. */
  nodeId: string;
  /** The iteration that dispatch would have had. It was not spent. */
  iteration: number;
  /** Every dispatch pending at the boundary, including `nodeId`'s. A run
   * parks only with exactly one pending, so this holds that one entry. */
  pending: Array<{ nodeId: string; iteration: number; via?: string }>;
  /** Edge traversal counts at the boundary, keyed `<from>-><to>:<when>`,
   * where a value edge's `<when>` is `output:<path>=<JSON>` or
   * `output:<path> in <JSON array>` (ADR 0055). Hand them back as `ResumeState.edgeTraversals` so the resumed run's
   * `max_traversals` budgets start where this run's stopped. */
  edgeTraversals: Record<string, number>;
  /** True when the parked dispatch was the seed of an answer (or quota or
   * failed-run) resume, so it held ADR 0042's privileges: the
   * `max_iterations` exemption and the human-answer block. Nothing was
   * dispatched, so the privileges were not used. Hand it back as
   * `ResumeState.resumeSeed` on the pause resume and that one dispatch gets
   * them again. */
  resumeSeed: boolean;
  /** The edge that queued the parked dispatch, keyed like `edgeTraversals`;
   * absent when no edge did (a start node, or a resume seed with no `via`).
   * Hand it back as `ResumeState.via` so the resumed dispatch renders the
   * same `{{ edge.traversals }}` / `{{ edge.max_traversals }}` (ADR 0050). */
  via?: string;
}

export interface RunResult {
  status: RunStatus;
  reason: RunReason;
  /** Node id that caused the terminal classification, when applicable. */
  proximateNodeId?: string;
  log: ExecutionLogEntry[];
  durationMs: number;
  /** Present exactly when `status` is `parked`. */
  parked?: ParkedRun;
}
