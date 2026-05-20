import { randomBytes } from "node:crypto";
import type { ExecutorRegistry } from "../executor/registry.js";
import type { RunHistoryEntry } from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { RunResult } from "../runner/result.js";
import { runFactory } from "../runner/run.js";
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

  constructor(private readonly buildRegistry: BuildRegistry) {}

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  start(input: StartRunInput, factory: LoadedFactory): StartRunOutcome {
    for (const r of this.runs.values()) {
      if (r.factoryId === input.factoryId && r.status === "running") {
        return { ok: false, code: "run_in_flight", activeRunId: r.id };
      }
    }
    const id = randomBytes(8).toString("hex");
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
