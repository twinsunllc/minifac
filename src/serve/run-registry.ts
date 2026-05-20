import { randomUUID } from "node:crypto";
import type { ExecutorRegistry } from "../executor/registry.js";
import type { RunHistoryEntry } from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { RunResult } from "../runner/result.js";
import { runFactory } from "../runner/run.js";
import type { ListRunsFilter, RunStore, StoredEvent, StoredRun } from "../storage/run-store.js";
import type { SseWriter } from "./sse.js";

export type RunStatus = "pending" | "running" | "succeeded" | "failed";

/**
 * An event in the per-run log. Either a runner-emitted entry or a synthetic
 * `run_end` marker we emit when the run terminates.
 */
export type RunEventEntry =
  | ({ index: number; kind: "stdout" | "stderr" | "status" } & RunHistoryEntry)
  | {
      index: number;
      kind: "run_end";
      nodeId: null;
      iteration: 0;
      emittedAt: number;
      result: RunResult;
    };

export interface RunRecord {
  id: string;
  factoryId: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  result?: RunResult;
  events: RunEventEntry[];
}

export interface StartRunInput {
  factoryId: string;
  cwd?: string;
}

export type StartRunOutcome =
  | { ok: true; run: RunRecord }
  | { ok: false; code: "run_in_flight"; activeRunId: string };

type Sink = (entry: RunEventEntry) => void;

interface Subscriber {
  sink: Sink;
  writer?: SseWriter;
}

export type BuildRegistry = () => ExecutorRegistry;

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly buildRegistry: BuildRegistry;
  private readonly store?: RunStore;

  constructor(buildRegistry: BuildRegistry, store?: RunStore) {
    this.buildRegistry = buildRegistry;
    this.store = store;
  }

  /**
   * Hydrate the in-memory cache from the durable store. Any rows the store
   * lists as `running` are stale (the daemon that wrote them is dead by
   * definition); we mark them `failed` with reason `daemon_restart` so the
   * viewer doesn't show phantom in-flight runs.
   */
  async hydrate(opts: { limit?: number } = {}): Promise<void> {
    if (!this.store) return;
    const limit = opts.limit ?? 100;
    const rows = await this.store.listRuns({ limit });
    const now = Date.now();
    for (const r of rows) {
      const record: RunRecord = {
        id: r.id,
        factoryId: r.factoryName,
        status: r.status,
        startedAt: r.startedAt,
        ...(r.endedAt !== null ? { endedAt: r.endedAt } : {}),
        events: [],
      };
      if (r.status === "running") {
        record.status = "failed";
        record.endedAt = now;
        record.result = {
          status: "failed",
          reason: "node_failed",
          log: [],
          durationMs: now - r.startedAt,
        };
        try {
          await this.store.finalizeRun(r.id, {
            status: "failed",
            reason: "daemon_restart",
            endedAt: now,
          });
        } catch {
          // best effort — the row is honest about restart even if the update fails
        }
      } else if (r.endedAt !== null) {
        record.result = {
          status: r.status === "succeeded" ? "succeeded" : "failed",
          reason: (r.reason as RunResult["reason"]) ?? "node_failed",
          log: [],
          durationMs: r.endedAt - r.startedAt,
          ...(r.proximateNodeId ? { proximateNodeId: r.proximateNodeId } : {}),
        };
      }
      this.runs.set(r.id, record);
    }
  }

  list(filter?: ListRunsFilter): RunRecord[] {
    let runs = [...this.runs.values()];
    if (filter?.factoryName !== undefined) {
      runs = runs.filter((r) => r.factoryId === filter.factoryName);
    }
    if (filter?.status !== undefined) {
      runs = runs.filter((r) => r.status === filter.status);
    }
    // `change` filter is store-side; in-memory records don't carry it.
    runs.sort((a, b) => b.startedAt - a.startedAt);
    if (filter?.limit !== undefined) {
      const offset = filter.offset ?? 0;
      runs = runs.slice(offset, offset + filter.limit);
    }
    return runs;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /**
   * Fetch a run that may not be in the in-memory cache (e.g. from a prior
   * daemon process). Returns a RunRecord-shaped object with events loaded
   * from the store.
   */
  async getWithEvents(id: string): Promise<RunRecord | undefined> {
    const cached = this.runs.get(id);
    if (cached && cached.events.length > 0) return cached;
    if (!this.store) return cached;

    const stored = await this.store.getRun(id);
    if (!stored) return cached;

    const events = await this.store.getRunEvents(id);
    const record: RunRecord = cached ?? {
      id: stored.id,
      factoryId: stored.factoryName,
      status: stored.status,
      startedAt: stored.startedAt,
      ...(stored.endedAt !== null ? { endedAt: stored.endedAt } : {}),
      events: [],
    };
    record.events = events.map((e, i) => storedEventToEntry(e, i, stored));
    if (stored.status !== "running" && stored.endedAt !== null && !record.result) {
      record.result = {
        status: stored.status === "succeeded" ? "succeeded" : "failed",
        reason: (stored.reason as RunResult["reason"]) ?? "node_failed",
        log: [],
        durationMs: stored.endedAt - stored.startedAt,
        ...(stored.proximateNodeId ? { proximateNodeId: stored.proximateNodeId } : {}),
      };
    }
    this.runs.set(id, record);
    return record;
  }

  start(input: StartRunInput, factory: LoadedFactory): StartRunOutcome {
    for (const r of this.runs.values()) {
      if (r.factoryId === input.factoryId && r.status === "running") {
        return { ok: false, code: "run_in_flight", activeRunId: r.id };
      }
    }
    const id = randomUUID();
    const record: RunRecord = {
      id,
      factoryId: input.factoryId,
      status: "running",
      startedAt: Date.now(),
      events: [],
    };
    this.runs.set(id, record);
    this.subscribers.set(id, new Set());

    const loaded = applyCwdOverride(factory, input.cwd);
    const registry = this.buildRegistry();

    // Fire-and-forget; the result is recorded by recordResult.
    runFactory(loaded, {
      registry,
      runId: id,
      ...(input.cwd ? { runCwd: input.cwd } : {}),
      ...(this.store ? { store: this.store } : {}),
      onEvent: (entry) => this.recordEvent(id, entry),
    })
      .then((result) => this.recordResult(id, result))
      .catch((err) => {
        const result: RunResult = {
          status: "failed",
          reason: "node_failed",
          log: [],
          durationMs: 0,
        };
        record.events.push({
          index: record.events.length,
          nodeId: "__runner__",
          iteration: 0,
          emittedAt: Date.now() - record.startedAt,
          kind: "stderr",
          event: { kind: "stderr", line: `runner crashed: ${(err as Error).message}` },
        });
        this.recordResult(id, result);
      });

    return { ok: true, run: record };
  }

  subscribe(
    runId: string,
    lastIndex: number | undefined,
    sink: Sink,
    writer?: SseWriter,
  ): { unsubscribe(): void } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    // Replay buffered.
    const start = lastIndex === undefined ? 0 : lastIndex + 1;
    for (let i = start; i < run.events.length; i++) {
      const e = run.events[i];
      if (e) sink(e);
    }

    // If the run already ended, do not attach a live subscriber — the
    // `run_end` synthetic marker is already in the buffer.
    if (run.status === "succeeded" || run.status === "failed") {
      return { unsubscribe() {} };
    }

    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    const sub: Subscriber = writer ? { sink, writer } : { sink };
    set.add(sub);
    return {
      unsubscribe: () => {
        set?.delete(sub);
      },
    };
  }

  closeAllSubscribers(): void {
    for (const set of this.subscribers.values()) {
      for (const sub of set) {
        if (sub.writer && !sub.writer.closed) {
          try {
            sub.writer.close();
          } catch {
            // ignore
          }
        }
      }
      set.clear();
    }
    this.subscribers.clear();
  }

  private recordEvent(runId: string, entry: RunHistoryEntry): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const idx = run.events.length;
    const stamped: RunEventEntry = {
      index: idx,
      kind: entry.event.kind,
      nodeId: entry.nodeId,
      iteration: entry.iteration,
      emittedAt: entry.emittedAt,
      event: entry.event,
    } as RunEventEntry;
    run.events.push(stamped);
    const subs = this.subscribers.get(runId);
    if (subs) {
      for (const s of subs) s.sink(stamped);
    }
  }

  private recordResult(runId: string, result: RunResult): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.status === "succeeded" || run.status === "failed") return;
    run.status = result.status === "succeeded" ? "succeeded" : "failed";
    run.result = result;
    run.endedAt = Date.now();
    const idx = run.events.length;
    const terminal: RunEventEntry = {
      index: idx,
      kind: "run_end",
      nodeId: null,
      iteration: 0,
      emittedAt: run.endedAt - run.startedAt,
      result,
    };
    run.events.push(terminal);
    const subs = this.subscribers.get(runId);
    if (subs) {
      for (const s of subs) s.sink(terminal);
      this.subscribers.delete(runId);
    }
  }
}

function applyCwdOverride(factory: LoadedFactory, cwd: string | undefined): LoadedFactory {
  if (!cwd) return factory;
  return { ...factory, sourceDir: cwd };
}

function storedEventToEntry(e: StoredEvent, index: number, stored: StoredRun): RunEventEntry {
  if (e.kind === "run_end") {
    const result: RunResult = {
      status: stored.status === "succeeded" ? "succeeded" : "failed",
      reason: (stored.reason as RunResult["reason"]) ?? "node_failed",
      log: [],
      durationMs: (stored.endedAt ?? stored.startedAt) - stored.startedAt,
      ...(stored.proximateNodeId ? { proximateNodeId: stored.proximateNodeId } : {}),
    };
    return {
      index,
      kind: "run_end",
      nodeId: null,
      iteration: 0,
      emittedAt: e.emittedAt,
      result,
    };
  }
  return {
    index,
    kind: e.kind,
    nodeId: e.nodeId ?? "",
    iteration: e.iteration,
    emittedAt: e.emittedAt,
    event: e.payload as RunHistoryEntry["event"],
  } as RunEventEntry;
}
