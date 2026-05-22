/**
 * Pluggable durable storage for run history. The SQLite adapter in
 * `./sqlite.ts` is the only shipped implementation; a future remote-backed
 * adapter (Dolt, HTTP, …) implements the same interface. Async on every
 * method so the swap is cheap.
 *
 * See `openspec/changes/run-history-persistence/design.md`.
 */

import type { NodeOutputIndex, NodeOutputType } from "../factory/schema.js";

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
  status: RunStatus;
  reason: string | null;
  proximateNodeId: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface GetEventsOptions {
  sinceSeq?: number;
  limit?: number;
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
}
