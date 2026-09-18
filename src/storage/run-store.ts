/**
 * Pluggable durable storage for run history. The SQLite adapter in
 * `./sqlite.ts` is the only shipped implementation; a future remote-backed
 * adapter (Dolt, HTTP, …) implements the same interface. Async on every
 * method so the swap is cheap.
 *
 * See `openspec/changes/run-history-persistence/design.md`.
 */

import type { NodeOutputIndex, NodeOutputType } from "../factory/schema.js";
import type { LibraryPin } from "../library/library.js";

// Re-export the canonical types so all storage consumers share the same shape.
export type {
  NodeOutputEntry,
  NodeOutputIndex,
  NodeOutputType,
} from "../factory/schema.js";

export type RunId = string;

export type RunStatus = "running" | "succeeded" | "failed";

export type StoredEventKind =
  | "stdout"
  | "stderr"
  | "status"
  | "run_end"
  | "runner-action"
  | "runner-nudge";

export interface CreateRunInput {
  id: RunId;
  factoryPath: string;
  factoryName: string;
  briefPath?: string | null;
  change?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
  branchName?: string | null;
  /** The project's pinned library, resolved to a commit sha, when the
   * factory loaded one (ADR 0039). Answers "which workflow ran". */
  library?: LibraryPin | null;
  startedAt: number;
}

export interface AppendEventInput {
  nodeId: string | null;
  iteration: number;
  kind: StoredEventKind;
  payload: unknown;
  emittedAt: number;
}

export interface StoredEvent {
  seq: number;
  nodeId: string | null;
  iteration: number;
  kind: StoredEventKind;
  payload: unknown;
  emittedAt: number;
}

export interface FinalizeRunInput {
  status: "succeeded" | "failed";
  reason?: string | null;
  proximateNodeId?: string | null;
  endedAt: number;
}

export interface RecordNodeEndInput {
  status: "succeeded" | "failed" | "skipped";
  sentinelStatus?: string | null;
  exitCode?: number | null;
  /** Executor session id announced by this node execution, or `null` when
   * none was announced. Not unique: two executions that continued one
   * conversation legitimately share an id. It is the join key from a
   * finished run back to the session transcript (e.g. for splitting cost
   * by model across a resume cascade). */
  sessionId?: string | null;
  at: number;
}

export interface ListRunsFilter {
  factoryName?: string;
  change?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export interface StoredRun {
  id: RunId;
  factoryPath: string;
  factoryName: string;
  briefPath: string | null;
  change: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  branchName: string | null;
  library: LibraryPin | null;
  status: RunStatus;
  reason: string | null;
  proximateNodeId: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface GetEventsOptions {
  sinceSeq?: number;
  limit?: number;
  /** Return only events of this kind. A hint: an adapter that cannot filter
   * MAY ignore it, so callers that need the guarantee filter again. The
   * SQLite adapter pushes it into SQL, which is what keeps a resume-state
   * rebuild off the whole (stdout-dominated) event log. */
  kind?: StoredEventKind;
}

/** One `node_executions` row. Read back only by the resume-state rebuild. */
export interface NodeExecutionRow {
  runId: RunId;
  nodeId: string;
  iteration: number;
  status: "running" | "succeeded" | "failed" | "skipped";
  startedAt: number;
  endedAt: number | null;
  sessionId: string | null;
}

export interface NodeOutputRow {
  runId: string;
  nodeId: string;
  iteration: number;
  outputKey: string;
  outputType: NodeOutputType;
  path: string;
  size: number;
  mtime: number;
}

export interface GetNodeOutputsFilter {
  nodeId?: string;
  iteration?: number;
}

export interface RunStore {
  createRun(input: CreateRunInput): Promise<void>;
  appendEvent(runId: RunId, event: AppendEventInput): Promise<StoredEvent>;
  recordNodeStart(runId: RunId, nodeId: string, iteration: number, at: number): Promise<void>;
  recordNodeEnd(
    runId: RunId,
    nodeId: string,
    iteration: number,
    end: RecordNodeEndInput,
  ): Promise<void>;
  recordNodeOutputs(
    runId: RunId,
    nodeId: string,
    iteration: number,
    outputs: NodeOutputIndex,
  ): Promise<void>;
  getNodeOutputs(runId: RunId, filter?: GetNodeOutputsFilter): Promise<NodeOutputRow[]>;
  finalizeRun(runId: RunId, input: FinalizeRunInput): Promise<void>;
  getRun(runId: RunId): Promise<StoredRun | null>;
  listRuns(filter?: ListRunsFilter): Promise<StoredRun[]>;
  getRunEvents(runId: RunId, opts?: GetEventsOptions): Promise<StoredEvent[]>;
  close(): Promise<void>;
  /** Optional: delete `node_outputs` rows for a given run id. The SQLite
   * adapter implements this; in-memory test stubs may omit it. */
  deleteNodeOutputsForRun?(runId: RunId): Promise<void>;
  /** Optional: every `node_executions` row of a run, ascending by node then
   * iteration. Read by `resumeStateFromStore` to rebuild a finished run's
   * `priorResults` and per-node iteration counts.
   *
   * OPTIONAL, like `deleteNodeOutputsForRun`, and for the same reason: the
   * droid's structurally-typed adapter in twinsunllc/scarif-worker is
   * assignable to this interface by shape alone, so a required method would
   * break its build the moment this one shipped. */
  getNodeExecutions?(runId: RunId): Promise<NodeExecutionRow[]>;
  /** Optional: put a finished run back to `running`, clearing `ended_at`,
   * `reason` and `proximate_node_id`, so a resumed segment appends to the
   * same run row rather than opening a second one. A no-op when the run id
   * is unknown. */
  reopenRun?(runId: RunId): Promise<void>;
}
