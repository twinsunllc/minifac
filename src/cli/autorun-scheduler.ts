import {
  type AncestorCleanlinessResult,
  type GitStatusRunner,
  checkBriefAndAncestorsCleanliness,
} from "../brief/cleanliness.js";
import type { Brief } from "../brief/loader.js";
import { BriefCycleError, computeBriefState } from "../brief/state.js";
import type { RunStatus, RunStore } from "../storage/run-store.js";
import type { LockProbeResult } from "../worktree/lock.js";
import type { AutorunFilter } from "./autorun-filter.js";

export type SkipReason =
  | "blocked"
  | "concurrency"
  | "failure-cap"
  | "filtered"
  | "in-flight"
  | "running-elsewhere"
  | "activity-succeeded"
  | "done"
  | "unclean";

/** Probe the per-change lockfile to classify a row that says `running` as
 *  either a real in-flight run (some live PID still holds the lock) or an
 *  orphan (lockfile missing OR PID dead). See `auto-mode` capability,
 *  "Autorun reconciles orphaned runs via per-change lockfile probe". */
export type ProbeChangeLiveness = (change: string, factoryName: string) => Promise<LockProbeResult>;

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
  /** Optional per-event sink: each `EmittedEvent` the run primitive yields
   *  for this brief's run is forwarded here. Used by the autorun TUI so
   *  the per-brief embedded run view reflects live progress. */
  onRunEvent?: (entry: import("../executor/types.js").EmittedEvent) => void;
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
  /** Optional per-event sink: every `EmittedEvent` from a brief's run is
   *  forwarded here (tagged with the brief's change name). Used by the
   *  autorun TUI to drive each brief's embedded `RunState`. */
  onRunEvent?(change: string, entry: import("../executor/types.js").EmittedEvent): void;
}

export interface SchedulerDeps {
  runFactory: AutorunRunFactory;
  runStore: RunStore;
  inputsDir: string;
  repoRoot: string;
  maxConcurrent: number;
  /** Per-session failure cap per change. `0` disables the cap (legacy
   *  indefinite-retry behavior). See `auto-mode` capability, "Autorun
   *  per-session failure cap". */
  maxFailures: number;
  callbacks?: SchedulerCallbacks;
  /** Probe the per-change lockfile for liveness when the most-recent
   *  `runs.db` row carries `status='running'`. The default (no probe)
   *  treats every running row as a legitimately busy run elsewhere and
   *  skips with `running-elsewhere`; the real CLI plugs in a probe that
   *  reads the lockfile under `~/.minifac/locks/`. See `auto-mode`
   *  capability, "Autorun reconciles orphaned runs via per-change
   *  lockfile probe". */
  probeChangeLiveness?: ProbeChangeLiveness;
  /** Override `Date.now()` for tests that need a deterministic
   *  `ended_at` value when reconciling an orphan. */
  now?: () => number;
  /** Inject a git status runner for the cleanliness probe (tests). */
  cleanlinessRunner?: GitStatusRunner;
  /** Invoked exactly once per scheduler instance, the first time the
   *  cleanliness probe reports the working tree is not a git repo.
   *  Per `auto-mode` capability, "Disabled gate emits one-time startup
   *  warning". */
  onCleanlinessDisabled?: () => void;
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
  /** Per-session failure counter keyed by `change`. Increments in the
   *  post-run handler when a dispatched run completes `failed` with a
   *  non-`user_quit` reason. Consulted by `decide()` before the
   *  concurrency check. Purely in-memory: restart autorun to reset. */
  private readonly failureCounts = new Map<string, number>();
  private readonly maxFailures: number;
  private killedAny = false;
  /** Tracks whether the cleanliness probe's "disabled" warning has
   *  already fired. The warning fires once per scheduler instance. */
  private disabledWarned = false;
  /** Latch: once the cleanliness probe reports `disabled`, subsequent
   *  decides skip the probe entirely. Re-spawning git on every decide
   *  is wasteful when we already know the working tree isn't a repo. */
  private cleanlinessDisabled = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.maxFailures = deps.maxFailures;
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  anyKilled(): boolean {
    return this.killedAny;
  }

  failureCount(change: string): number {
    return this.failureCounts.get(change) ?? 0;
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

    // Cleanliness gate — runs BEFORE `computeBriefState` so the scheduler
    // never reads brief state from an in-flux file. See `auto-mode`
    // capability, "Autorun brief cleanliness gate". Cycles are NOT
    // surfaced as `unclean` here; they fall through to the existing
    // state-machine path which converts BriefCycleError to `blocked`.
    // Skip the probe entirely once we've latched the disabled state —
    // spawning git per-decide is wasteful in a non-repo cwd.
    let cleanliness: AncestorCleanlinessResult | undefined;
    if (this.cleanlinessDisabled) {
      cleanliness = { status: "disabled" };
    } else {
      try {
        cleanliness = await checkBriefAndAncestorsCleanliness(brief, {
          inputsDir: this.deps.inputsDir,
          repoRoot: this.deps.repoRoot,
          loadBrief: async (c: string) => {
            if (c === change) return brief;
            const { loadBrief } = await import("../brief/loader.js");
            return loadBrief(c, this.deps.repoRoot);
          },
          ...(this.deps.cleanlinessRunner ? { runner: this.deps.cleanlinessRunner } : {}),
        });
      } catch (err) {
        if (!(err instanceof BriefCycleError)) throw err;
        // Cycle → fall through to computeBriefState which raises the same
        // error and yields `blocked` via the path below.
      }
    }
    if (cleanliness) {
      if (cleanliness.status === "disabled") {
        this.cleanlinessDisabled = true;
        if (!this.disabledWarned) {
          this.disabledWarned = true;
          this.deps.onCleanlinessDisabled?.();
        }
        // Fall through to the existing dispatch path.
      } else if (cleanliness.status === "unclean") {
        const detail =
          cleanliness.offending === change
            ? cleanliness.code
            : `${cleanliness.offending} (${cleanliness.code})`;
        return { action: "skip", reason: "unclean", brief, detail };
      }
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

    // Orphan reconciliation: when the most-recent `runs.db` row says
    // `running`, the row may reflect a killed runner whose lockfile is
    // gone or whose PID is dead. Probe the per-change lockfile to decide
    // — see the `auto-mode` capability's "Autorun reconciles orphaned
    // runs via per-change lockfile probe" requirement. Run this BEFORE
    // doneness/blocked so the row flips even on a brief that is
    // ultimately ineligible to schedule this cycle (the orphan still
    // needs reaping so future polls aren't stuck either).
    if (state.activity === "running") {
      let probe: LockProbeResult | undefined;
      try {
        probe = this.deps.probeChangeLiveness
          ? await this.deps.probeChangeLiveness(change, brief.frontmatter.factory)
          : undefined;
      } catch {
        // I/O failure during probe → conservative: skip without touching
        // the row. The scheduler retries next poll.
        return { action: "skip", reason: "running-elsewhere", brief };
      }
      if (!probe || "running" in probe) {
        return { action: "skip", reason: "running-elsewhere", brief };
      }
      // Orphan: flip the running row to failed/orphaned. Best-effort —
      // a finalize rejection falls back to the conservative skip path.
      if (state.mostRecentRunId !== undefined) {
        try {
          const now = this.deps.now ? this.deps.now() : Date.now();
          await this.deps.runStore.finalizeRun(state.mostRecentRunId, {
            status: "failed",
            reason: "orphaned",
            endedAt: now,
          });
        } catch {
          return { action: "skip", reason: "running-elsewhere", brief };
        }
      }
      // Fall through to the remaining readiness checks. `state.activity`
      // is now stale (the row is `failed`), but every remaining check
      // either ignores activity or matches the new "not running" state.
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
    if (state.activity === "succeeded") {
      return { action: "skip", reason: "activity-succeeded", brief };
    }
    // Precedence: in-flight, filtered, running-elsewhere, done, blocked,
    // activity-succeeded short-circuit above. Concurrency check runs
    // after this. See `auto-mode` capability, "Autorun per-session
    // failure cap".
    const failureCount = this.failureCounts.get(change) ?? 0;
    if (this.maxFailures > 0 && failureCount >= this.maxFailures) {
      return {
        action: "skip",
        reason: "failure-cap",
        brief,
        detail: `${failureCount}/${this.maxFailures}`,
      };
    }
    if (this.inFlight.size >= this.deps.maxConcurrent) {
      return { action: "skip", reason: "concurrency", brief };
    }
    return { action: "schedule", brief };
  }

  start(brief: Brief): void {
    const change = brief.frontmatter.change;
    if (this.inFlight.has(change)) return;
    const onRunEvent = this.deps.callbacks?.onRunEvent;
    const started = this.deps.runFactory({
      brief,
      ...(onRunEvent ? { onRunEvent: (entry) => onRunEvent(change, entry) } : {}),
    });
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
        // Bump the failure counter before callbacks fire so any
        // observer of the count sees the post-increment value.
        if (result.status === "failed" && result.reason !== "user_quit") {
          this.failureCounts.set(change, (this.failureCounts.get(change) ?? 0) + 1);
        }
        this.deps.callbacks?.onCompleted?.({
          change,
          status: result.status,
          ...(result.runId !== undefined ? { runId: result.runId } : {}),
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        });
      },
      (err: Error) => {
        this.inFlight.delete(change);
        // Thrown errors are brief-side failures; no `user_quit`
        // synthesis on the throw path.
        this.failureCounts.set(change, (this.failureCounts.get(change) ?? 0) + 1);
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
