import type { Brief } from "../brief/loader.js";
import { BriefCycleError, computeBriefState } from "../brief/state.js";
import type { RunStatus, RunStore } from "../storage/run-store.js";
import type { AutorunFilter } from "./autorun-filter.js";

export type SkipReason =
  | "blocked"
  | "concurrency"
  | "filtered"
  | "in-flight"
  | "activity-running"
  | "activity-succeeded"
  | "done";

export type SchedulerDecision =
  | { action: "schedule"; brief: Brief }
  | { action: "skip"; reason: SkipReason; brief: Brief; detail?: string };

export interface RunFactoryResult {
  status: "succeeded" | "failed";
  runId?: string;
  reason?: string;
}

export interface RunFactoryArgs {
  brief: Brief;
  abortSignal?: AbortSignal;
}

export interface ChildHandle {
  kill(signal?: NodeJS.Signals): void;
}

export interface RunStartResult {
  promise: Promise<RunFactoryResult>;
  child?: ChildHandle;
}

/**
 * Function the Scheduler calls to actually invoke a brief. Returns a
 * promise that settles with the run's terminal status, and an optional
 * `child` handle the scheduler can SIGTERM on escalation.
 */
export type AutorunRunFactory = (args: RunFactoryArgs) => RunStartResult;

export interface AutorunStartedEvent {
  change: string;
  runId?: string;
}

export interface AutorunCompletedEvent {
  change: string;
  runId?: string;
  status: "succeeded" | "failed";
  reason?: string;
}

export interface SchedulerCallbacks {
  onStarted?(event: AutorunStartedEvent): void;
  onCompleted?(event: AutorunCompletedEvent): void;
  onError?(change: string, err: Error): void;
}

export interface SchedulerDeps {
  runFactory: AutorunRunFactory;
  runStore: RunStore;
  inputsDir: string;
  repoRoot: string;
  maxConcurrent: number;
  callbacks?: SchedulerCallbacks;
}

interface InFlightEntry {
  change: string;
  promise: Promise<RunFactoryResult>;
  child?: ChildHandle;
  killed?: boolean;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly inFlight = new Map<string, InFlightEntry>();
  private killedAny = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  anyKilled(): boolean {
    return this.killedAny;
  }

  async decide(brief: Brief, filter?: AutorunFilter): Promise<SchedulerDecision> {
    const change = brief.frontmatter.change;
    // Pre-state checks that don't need the run store.
    if (this.inFlight.has(change)) {
      return { action: "skip", reason: "in-flight", brief };
    }
    if (filter && !filter.match(change)) {
      return { action: "skip", reason: "filtered", brief };
    }

    let state: Awaited<ReturnType<typeof computeBriefState>>;
    try {
      state = await computeBriefState(change, {
        inputsDir: this.deps.inputsDir,
        repoRoot: this.deps.repoRoot,
        runStore: this.deps.runStore,
        // Caller already loaded the root brief; reuse it to keep file
        // name vs frontmatter `change:` drift from re-resolving.
        loadBrief: async (c: string) => {
          if (c === change) return brief;
          const { loadBrief } = await import("../brief/loader.js");
          return loadBrief(c, this.deps.repoRoot);
        },
      });
    } catch (err) {
      if (err instanceof BriefCycleError) {
        // Cycles are non-recoverable until human intervention. Treat as
        // blocked for autorun purposes; the logger surfaces the detail.
        return {
          action: "skip",
          reason: "blocked",
          brief,
          detail: `cycle: ${err.cycle.join(" -> ")}`,
        };
      }
      throw err;
    }

    if (state.doneness === "done") {
      return { action: "skip", reason: "done", brief };
    }
    if (state.blocked) {
      return {
        action: "skip",
        reason: "blocked",
        brief,
        ...(state.blockedReason ? { detail: state.blockedReason } : {}),
      };
    }
    if (state.activity === "running") {
      return { action: "skip", reason: "activity-running", brief };
    }
    if (state.activity === "succeeded") {
      return { action: "skip", reason: "activity-succeeded", brief };
    }
    if (this.inFlight.size >= this.deps.maxConcurrent) {
      return { action: "skip", reason: "concurrency", brief };
    }
    return { action: "schedule", brief };
  }

  start(brief: Brief): void {
    const change = brief.frontmatter.change;
    if (this.inFlight.has(change)) return;
    const started = this.deps.runFactory({ brief });
    const entry: InFlightEntry = {
      change,
      promise: started.promise,
      ...(started.child ? { child: started.child } : {}),
    };
    this.inFlight.set(change, entry);
    // Emit started synchronously so the log sequence is deterministic.
    let runIdHint: string | undefined;
    // The promise will resolve with the runId; emit started before drain,
    // including runId only when synchronously available is impossible. We
    // emit started here; runId surfaces on completed.
    this.deps.callbacks?.onStarted?.(
      runIdHint !== undefined ? { change, runId: runIdHint } : { change },
    );

    started.promise.then(
      (result) => {
        this.inFlight.delete(change);
        this.deps.callbacks?.onCompleted?.({
          change,
          status: result.status,
          ...(result.runId !== undefined ? { runId: result.runId } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        });
      },
      (err: Error) => {
        this.inFlight.delete(change);
        this.deps.callbacks?.onError?.(change, err);
        this.deps.callbacks?.onCompleted?.({
          change,
          status: "failed",
          reason: err.message,
        });
      },
    );
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      const promises = Array.from(this.inFlight.values()).map((e) =>
        e.promise.catch(() => undefined),
      );
      await Promise.all(promises);
    }
  }

  killAllInFlight(): void {
    for (const entry of this.inFlight.values()) {
      if (entry.child) {
        try {
          entry.child.kill("SIGTERM");
          entry.killed = true;
          this.killedAny = true;
        } catch {
          // best effort
        }
      }
    }
  }
}

export type { RunStatus };
