/**
 * Pluggable durable storage for run history. The SQLite adapter in
 * `./sqlite.ts` is the only shipped implementation; a future remote-backed
 * adapter (Dolt, HTTP, …) implements the same interface. Async on every
 * method so the swap is cheap.
 *
 * See `openspec/changes/run-history-persistence/design.md`.
 */

export type RunId = string;

export type RunStatus = "running" | "succeeded" | "failed";

export type StoredEventKind = "stdout" | "stderr" | "status" | "run_end";

export interface CreateRunInput {
  id: RunId;
  factoryPath: string;
  factoryName: string;
  briefPath?: string | null;
  change?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
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

export interface RunStore {
  createRun(input: CreateRunInput): Promise<void>;
  appendEvent(runId: RunId, event: AppendEventInput): Promise<StoredEvent>;
  recordNodeStart(
    runId: RunId,
    nodeId: string,
    iteration: number,
    at: number,
  ): Promise<void>;
  recordNodeEnd(
    runId: RunId,
    nodeId: string,
    iteration: number,
    end: RecordNodeEndInput,
  ): Promise<void>;
  finalizeRun(runId: RunId, input: FinalizeRunInput): Promise<void>;
  getRun(runId: RunId): Promise<StoredRun | null>;
  listRuns(filter?: ListRunsFilter): Promise<StoredRun[]>;
  getRunEvents(runId: RunId, opts?: GetEventsOptions): Promise<StoredEvent[]>;
  close(): Promise<void>;
}
