import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type Brief, BriefLoadError, loadBrief } from "../brief/loader.js";
import type { ExecutorRegistry } from "../executor/registry.js";
import type { EmittedEvent } from "../executor/types.js";
import { loadFactory } from "../factory/loader.js";
import { markBriefDone } from "../runner/mark-done.js";
import { openDefaultRunStore } from "../storage/open.js";
import type { RunStore, StoredRun } from "../storage/run-store.js";
import { type InkAutorunRenderer, createInkAutorunRenderer } from "../tui/autorun-renderer.js";
import { loadWorktreeConfig } from "../worktree/config.js";
import { probeLockLiveness } from "../worktree/lock.js";
import { computeRepoHash, lockPathForKey, worktreeKeyForBrief } from "../worktree/paths.js";
import { type AutorunFilter, AutorunFilterError, parseAutorunFilter } from "./autorun-filter.js";
import {
  type AutorunRunFactory,
  type RunFactoryArgs,
  Scheduler,
  type SchedulerDecision,
  type SkipReason,
} from "./autorun-scheduler.js";
import { type MergeOutcome, type MergeRunOptions, mergeRun } from "./merge.js";
import { resolveFactoryByName } from "./resolve.js";
import { runBriefAutomated } from "./run-brief.js";

export interface AutorunIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface AutorunOptions {
  watch?: string;
  maxConcurrent?: number;
  interval?: number;
  once?: boolean;
  filter?: string;
  dryRun?: boolean;
  json?: boolean;
  force?: boolean;
  raw?: boolean;
  tui?: boolean;
  /** Opt out of the auto-merge step in autorun's completion handler.
   *  When true, autorun restores today's behavior exactly: no merge call,
   *  the runner's mark-done post-step is NOT suppressed, the brief moves
   *  to `inputs/done/` unconditionally on factory success, and no
   *  `auto-merge-failed` events fire. */
  noAutoMerge?: boolean;
  /** Forwarded to `mergeRun` as `ffOnly`: a non-fast-forward merge becomes
   *  a merge failure rather than falling back to a merge commit. Under
   *  autorun, that failure surfaces as `auto-merge-failed
   *  reason=non-fast-forward`. When `noAutoMerge` is set, this flag is a
   *  no-op (warned at startup, not a usage error). */
  ffOnly?: boolean;
  /** Pre-resolved output mode from `pickOutputMode`. When omitted, the
   *  action falls back to raw. The CLI layer is responsible for picking
   *  the mode (and for refusing `--raw` + `--tui` / `--tui` + `--json`
   *  before reaching this point). */
  outputMode?: "raw" | "tui";
}

export type AutoMergeFailEventReason =
  | "conflict"
  | "non-fast-forward"
  | "dirty-working-tree"
  | "no-default-branch"
  | "null-branch-name"
  | "other";

export interface AutorunActionInput {
  options: AutorunOptions;
  cwd: string;
  io: AutorunIO;
  /** Inject the run primitive (tests). Default = `runBriefAutomated` wired
   * through the local repo + store. */
  runFactory?: AutorunRunFactory;
  /** Inject the run-history store opener (tests). */
  openRunStore?: (cwd: string) => Promise<RunStore>;
  /** Inject signal hookup so tests don't have to deal with process events. */
  installSignalHandlers?: (handlers: { onSignal: () => void }) => () => void;
  /** Inject the executor registry the default runFactory uses (integration tests). */
  buildRegistry?: () => ExecutorRegistry;
  /** Allow the test harness to override `Date.now()` semantics in logs. */
  now?: () => number;
  /** Inject the autorun TUI renderer factory (tests). */
  createAutorunTuiRenderer?: typeof createInkAutorunRenderer;
  /** @internal Test seam. Default = real `mergeRun`. Allows tests to
   *  exercise the auto-merge completion handler without spawning git. */
  mergeRunFn?: (row: StoredRun, opts: MergeRunOptions) => Promise<MergeOutcome>;
  /** @internal Test seam. Default = real `markBriefDone`. */
  markBriefDoneFn?: typeof markBriefDone;
}

interface ResolvedOptions {
  watch: string;
  maxConcurrent: number;
  interval: number;
  once: boolean;
  filter: AutorunFilter | undefined;
  filterExpr: string | undefined;
  dryRun: boolean;
  json: boolean;
  force: boolean;
  noAutoMerge: boolean;
  ffOnly: boolean;
  outputMode: "raw" | "tui";
}

interface AutorunEventBase {
  ts: number;
}

export type AutorunEvent =
  | (AutorunEventBase & { kind: "startup"; options: Record<string, unknown> })
  | (AutorunEventBase & { kind: "poll-start"; briefs: number })
  | (AutorunEventBase & { kind: "started"; change: string; runId?: string })
  | (AutorunEventBase & {
      kind: "skipped";
      change: string;
      reason: SkipReason;
      detail?: string;
    })
  | (AutorunEventBase & {
      kind: "completed";
      change: string;
      runId?: string;
      status: "succeeded" | "failed";
      reason?: string;
    })
  | (AutorunEventBase & {
      kind: "dry-run-decision";
      change: string;
      action: "schedule" | "skip";
      reason?: SkipReason;
      detail?: string;
    })
  | (AutorunEventBase & {
      kind: "info";
      message: string;
    })
  | (AutorunEventBase & {
      kind: "auto-merge-failed";
      change: string;
      runId?: string;
      reason: AutoMergeFailEventReason;
      detail?: string;
    });

export interface AutorunLogger {
  log(event: AutorunEvent): void;
}

function formatHuman(event: AutorunEvent): string {
  const ts = new Date(event.ts).toISOString();
  switch (event.kind) {
    case "startup":
      return `${ts} startup`;
    case "poll-start":
      return `${ts} poll-start briefs=${event.briefs}`;
    case "started":
      return `${ts} started ${event.change}${event.runId ? ` runId=${event.runId}` : ""}`;
    case "skipped":
      return `${ts} skipped ${event.change} reason=${event.reason}${
        event.detail ? ` detail=${event.detail}` : ""
      }`;
    case "completed":
      return `${ts} completed ${event.change} status=${event.status}${
        event.runId ? ` runId=${event.runId}` : ""
      }${event.reason ? ` reason=${event.reason}` : ""}`;
    case "dry-run-decision":
      return `${ts} dry-run-decision ${event.change} action=${event.action}${
        event.reason ? ` reason=${event.reason}` : ""
      }${event.detail ? ` detail=${event.detail}` : ""}`;
    case "info":
      return `${ts} info ${event.message}`;
    case "auto-merge-failed":
      return `${ts} auto-merge-failed ${event.change} reason=${event.reason}${
        event.runId ? ` runId=${event.runId}` : ""
      }${event.detail ? ` detail=${event.detail}` : ""}`;
  }
}

function makeLogger(io: AutorunIO, json: boolean): AutorunLogger {
  return {
    log(event) {
      if (json) {
        const payload: Record<string, unknown> = {
          event: event.kind,
          ts: new Date(event.ts).toISOString(),
        };
        for (const [k, v] of Object.entries(event)) {
          if (k === "kind" || k === "ts") continue;
          payload[k] = v;
        }
        io.stdout.write(`${JSON.stringify(payload)}\n`);
      } else {
        // Don't surface the startup event in human mode (per the design:
        // `--json`-mode startup event noting the resolved options).
        if (event.kind === "startup") return;
        io.stdout.write(`${formatHuman(event)}\n`);
      }
    },
  };
}

interface EnumeratedBrief {
  change: string;
  mtimeMs: number;
  brief: Brief;
}

export async function enumerateBriefs(
  watchDir: string,
  cwd: string,
  io: AutorunIO,
): Promise<EnumeratedBrief[]> {
  let entries: string[];
  try {
    const all = await readdir(watchDir, { withFileTypes: true });
    entries = all.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
  } catch {
    return [];
  }
  const out: EnumeratedBrief[] = [];
  for (const file of entries) {
    const full = path.join(watchDir, file);
    let mtimeMs = 0;
    try {
      const s = await stat(full);
      mtimeMs = s.mtimeMs;
    } catch {
      continue;
    }
    let brief: Brief;
    try {
      brief = await loadBrief(full, cwd);
    } catch (err) {
      const msg = err instanceof BriefLoadError ? err.message : (err as Error).message;
      io.stderr.write(`autorun: skipping unparseable brief ${full}: ${msg}\n`);
      continue;
    }
    out.push({ change: brief.frontmatter.change, mtimeMs, brief });
  }
  out.sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.change.localeCompare(b.change);
  });
  return out;
}

function validateOptions(
  options: AutorunOptions,
  cwd: string,
  io: AutorunIO,
): { ok: true; resolved: ResolvedOptions } | { ok: false; code: number } {
  const maxConcurrent = options.maxConcurrent ?? 1;
  const interval = options.interval ?? 10000;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    io.stderr.write(
      `--max-concurrent must be a positive integer (got \`${options.maxConcurrent}\`)\n`,
    );
    return { ok: false, code: 1 };
  }
  if (!Number.isInteger(interval) || interval <= 0) {
    io.stderr.write(`--interval must be a positive integer (got \`${options.interval}\`)\n`);
    return { ok: false, code: 1 };
  }

  let filter: AutorunFilter | undefined;
  if (options.filter !== undefined) {
    try {
      filter = parseAutorunFilter(options.filter);
    } catch (err) {
      if (err instanceof AutorunFilterError) {
        io.stderr.write(`${err.message}\n`);
        return { ok: false, code: 1 };
      }
      throw err;
    }
  }

  const watchDir = options.watch
    ? path.isAbsolute(options.watch)
      ? options.watch
      : path.resolve(cwd, options.watch)
    : path.resolve(cwd, "inputs");

  return {
    ok: true,
    resolved: {
      watch: watchDir,
      maxConcurrent,
      interval,
      once: options.once === true,
      filter,
      ...(options.filter !== undefined
        ? { filterExpr: options.filter }
        : { filterExpr: undefined }),
      dryRun: options.dryRun === true,
      json: options.json === true,
      force: options.force === true,
      noAutoMerge: options.noAutoMerge === true,
      ffOnly: options.ffOnly === true,
      outputMode: options.outputMode ?? "raw",
    },
  };
}

function buildDefaultRunFactory(
  cwd: string,
  store: RunStore | undefined,
  buildRegistry: (() => ExecutorRegistry) | undefined,
  skipMarkDone: boolean,
): AutorunRunFactory {
  return (args: RunFactoryArgs) => {
    const ac = new AbortController();
    const promise = runBriefAutomated({
      brief: args.brief,
      cwd,
      ...(store ? { store } : {}),
      abortSignal: ac.signal,
      ...(buildRegistry ? { buildRegistry } : {}),
      ...(args.onRunEvent ? { onEvent: args.onRunEvent } : {}),
      ...(skipMarkDone ? { skipMarkDone: true } : {}),
    }).then((result) => ({
      status: result.status,
      runId: result.runId,
      ...(result.reason ? { reason: result.reason } : {}),
    }));
    return {
      promise,
      child: {
        kill(_signal?: NodeJS.Signals) {
          ac.abort();
        },
      },
    };
  };
}

export async function autorunAction(input: AutorunActionInput): Promise<number> {
  const { options, cwd, io } = input;
  const validated = validateOptions(options, cwd, io);
  if (!validated.ok) return validated.code;
  const resolved = validated.resolved;

  // Watch dir must exist.
  try {
    const s = await stat(resolved.watch);
    if (!s.isDirectory()) {
      io.stderr.write(`--watch path is not a directory: ${resolved.watch}\n`);
      return 1;
    }
  } catch {
    io.stderr.write(`--watch directory does not exist: ${resolved.watch}\n`);
    return 1;
  }

  let store: RunStore | undefined;
  try {
    store = await (input.openRunStore ?? openDefaultRunStore)(cwd);
  } catch (err) {
    io.stderr.write(`Could not open run history store: ${(err as Error).message}\n`);
    return 1;
  }

  const logger = makeLogger(io, resolved.json);
  const now = input.now ?? (() => Date.now());

  // When the TUI is mounted, the human/JSON logger is suppressed (per the
  // `auto-mode` capability's "Autorun output mode selection" requirement).
  // After the user presses `r` (raw-switch), `suppressLog` flips back to
  // false so subsequent autorun events resume the existing log format.
  let suppressLog = resolved.outputMode === "tui";
  const emit = (event: AutorunEvent): void => {
    if (!suppressLog) logger.log(event);
  };

  emit({
    kind: "startup",
    ts: now(),
    options: {
      watch: resolved.watch,
      maxConcurrent: resolved.maxConcurrent,
      interval: resolved.interval,
      dryRun: resolved.dryRun,
      once: resolved.once,
      filter: resolved.filterExpr,
      force: resolved.force,
    },
  });

  const runFactory =
    input.runFactory ??
    buildDefaultRunFactory(cwd, store, input.buildRegistry, !resolved.noAutoMerge);

  // In-process mutex serializing the auto-merge step across concurrent
  // run completions. Each completion's merge work is chained onto this
  // promise so two merges never race against each other in the caller's
  // repo (each checks out the default branch and runs `git merge`). The
  // outer `await mergeQueue` in `drainOrEscalate` ensures `--once` does
  // not exit before in-flight merges finish.
  let mergeQueue: Promise<void> = Promise.resolve();
  const enqueueAutoMerge = (work: () => Promise<void>): void => {
    mergeQueue = mergeQueue.then(work, () => work().catch(() => undefined));
  };

  const mergeFn = input.mergeRunFn ?? mergeRun;
  const markFn = input.markBriefDoneFn ?? markBriefDone;

  const performAutoMerge = async (
    change: string,
    runId: string | undefined,
  ): Promise<void> => {
    if (!store) return;
    let row: StoredRun | null = null;
    try {
      if (runId) row = await store.getRun(runId);
    } catch {
      row = null;
    }
    if (!row) {
      const ev: AutorunEvent = {
        kind: "auto-merge-failed",
        ts: now(),
        change,
        ...(runId ? { runId } : {}),
        reason: "other",
        detail: "could not load run row from store",
      };
      emit(ev);
      renderer?.onEvent(ev);
      return;
    }
    if (row.branchName === null) {
      // In-place mode runs intentionally have no branch — the runner
      // already marked the brief done, so there's nothing for autorun to
      // do here. Discriminate via the worktree path: in-place runs share
      // the caller's cwd; legacy/pre-migration rows do not.
      if (row.worktreePath === cwd) return;
      const ev: AutorunEvent = {
        kind: "auto-merge-failed",
        ts: now(),
        change,
        ...(runId ? { runId } : {}),
        reason: "null-branch-name",
      };
      emit(ev);
      renderer?.onEvent(ev);
      return;
    }

    const mergeOpts: MergeRunOptions = {
      cwd,
      ...(resolved.ffOnly ? { ffOnly: true } : {}),
    };
    let outcome: MergeOutcome;
    try {
      outcome = await mergeFn(row, mergeOpts);
    } catch (err) {
      const ev: AutorunEvent = {
        kind: "auto-merge-failed",
        ts: now(),
        change,
        ...(runId ? { runId } : {}),
        reason: "other",
        detail: (err as Error).message,
      };
      emit(ev);
      renderer?.onEvent(ev);
      return;
    }

    if (!outcome.ok) {
      const ev: AutorunEvent = {
        kind: "auto-merge-failed",
        ts: now(),
        change,
        ...(runId ? { runId } : {}),
        reason: outcome.reason,
        ...(outcome.message ? { detail: outcome.message } : {}),
      };
      emit(ev);
      renderer?.onEvent(ev);
      return;
    }

    // Success — mark the brief done against the caller's cwd so the move
    // lands on the freshly-merged default branch (the brief that drives
    // autorun's poll loop lives in the caller's `inputs/`, not the
    // worktree's). The runner's mark-done block was suppressed precisely
    // so this wrapper-owned call can fire here.
    try {
      const mdr = await markFn({ change, runCwd: cwd });
      if (mdr.warning) {
        io.stderr.write(`${mdr.warning}\n`);
      }
    } catch (err) {
      io.stderr.write(`mark-done: unexpected error: ${(err as Error).message}\n`);
    }
  };

  // Build the default per-change lockfile liveness probe. The probe reads
  // the lockfile under `~/.minifac/locks/<repo-hash>-<change>-<factory>.lock`
  // and returns orphan/running per the `auto-mode` capability's "Autorun
  // reconciles orphaned runs via per-change lockfile probe" requirement.
  // Constructing the probe here (rather than per-decide) so we resolve
  // `repoHash` once per autorun lifetime, not once per poll.
  const worktreeConfig = await loadWorktreeConfig(cwd);
  const repoHash = await computeRepoHash(cwd);
  const probeChangeLiveness = async (
    change: string,
    factoryName: string,
  ): Promise<import("../worktree/lock.js").LockProbeResult> => {
    const key = worktreeKeyForBrief(repoHash, change, factoryName);
    const lockPath = lockPathForKey(worktreeConfig, key);
    return probeLockLiveness(lockPath);
  };

  // TUI renderer (when active). Bound below so the scheduler callbacks can
  // forward events to it.
  let renderer: InkAutorunRenderer | null = null;
  const initByChange = new Map<string, import("../tui/reducer.js").RunStateInit>();

  const scheduler = new Scheduler({
    runFactory,
    runStore: store,
    inputsDir: resolved.watch,
    repoRoot: cwd,
    maxConcurrent: resolved.maxConcurrent,
    probeChangeLiveness,
    callbacks: {
      onStarted(event) {
        const ev: AutorunEvent = {
          kind: "started",
          ts: now(),
          change: event.change,
          ...(event.runId ? { runId: event.runId } : {}),
        };
        emit(ev);
        renderer?.onEvent(ev);
        renderer?.setInFlight(scheduler.inFlightCount());
      },
      onCompleted(event) {
        const ev: AutorunEvent = {
          kind: "completed",
          ts: now(),
          change: event.change,
          status: event.status,
          ...(event.runId ? { runId: event.runId } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        };
        emit(ev);
        renderer?.onEvent(ev);
        renderer?.setInFlight(scheduler.inFlightCount());
        // Auto-merge step: serialized through `mergeQueue`. Only fires on a
        // factory-success completion when auto-merge is enabled. The
        // `auto-merge-failed` event SHALL appear AFTER the `completed`
        // event for the same change (per the `auto-mode` capability's
        // "Autorun auto-merge-failed event" requirement) — the queue
        // ensures that ordering even under `--max-concurrent N > 1`.
        if (!resolved.noAutoMerge && event.status === "succeeded") {
          enqueueAutoMerge(() => performAutoMerge(event.change, event.runId));
        }
      },
      onError(change, err) {
        const ev: AutorunEvent = {
          kind: "info",
          ts: now(),
          message: `run error for ${change}: ${err.message}`,
        };
        emit(ev);
        renderer?.onEvent(ev);
      },
      onRunEvent(change, entry) {
        renderer?.onRunEvent(change, entry);
      },
    },
  });

  let stopRequested = false;
  let forceRequested = resolved.force;
  let wakeUp: (() => void) | undefined;

  // Mount the autorun TUI when output mode is `tui`.
  if (resolved.outputMode === "tui") {
    const createRenderer = input.createAutorunTuiRenderer ?? createInkAutorunRenderer;
    renderer = createRenderer({
      watchBasename: path.basename(resolved.watch),
      maxConcurrent: resolved.maxConcurrent,
      getInFlight: () => scheduler.inFlightCount(),
      resolveRunInit: (change) => initByChange.get(change) ?? null,
      onQuitRequested: () => {
        stopRequested = true;
        wakeUp?.();
      },
    });
    renderer
      .waitForExit()
      .then(({ action, exitCode: rendererExit }) => {
        if (action === "raw-switch") {
          // Resume the human / JSON logger for the rest of the process
          // lifetime. The autorun loop continues uninterrupted.
          suppressLog = false;
          renderer = null;
        } else {
          // quit ⇒ honor renderer's exit code (0 normal, 2 escalation).
          stopRequested = true;
          if (rendererExit === 2) {
            forceRequested = true;
            scheduler.killAllInFlight();
          }
          wakeUp?.();
        }
      })
      .catch(() => undefined);
  }

  const handleSignal = (): void => {
    const escalate = stopRequested || resolved.force;
    stopRequested = true;
    if (escalate) {
      forceRequested = true;
      scheduler.killAllInFlight();
    }
    wakeUp?.();
  };

  const uninstallSignals = input.installSignalHandlers
    ? input.installSignalHandlers({ onSignal: handleSignal })
    : installDefaultSignalHandlers(handleSignal);

  const pollOnce = async (dryRun: boolean): Promise<void> => {
    const briefs = await enumerateBriefs(resolved.watch, cwd, io);
    const pollEv: AutorunEvent = { kind: "poll-start", ts: now(), briefs: briefs.length };
    emit(pollEv);
    renderer?.onEvent(pollEv);
    for (const b of briefs) {
      if (stopRequested && !dryRun) break;
      const decision = await scheduler.decide(b.brief, resolved.filter);
      if (dryRun) {
        emitDryRunDecision(
          decision,
          (e) => {
            emit(e);
            renderer?.onEvent(e);
          },
          now,
        );
        continue;
      }
      if (decision.action === "schedule") {
        // Pre-cache the factory's RunStateInit so the renderer can build
        // an embedded `RunState` slot when the first run event arrives.
        if (resolved.outputMode === "tui") {
          try {
            const fp = await resolveFactoryByName(decision.brief.frontmatter.factory, cwd);
            const loaded = await loadFactory(fp, cwd);
            initByChange.set(decision.brief.frontmatter.change, {
              factory: { name: loaded.factory.name },
              brief: { change: decision.brief.frontmatter.change },
              nodeIds: Object.keys(loaded.factory.nodes),
              branchName: null,
            });
          } catch {
            // Best-effort. Brief row still updates from autorun-level
            // events; the embedded view stays empty for this brief.
          }
        }
        scheduler.start(decision.brief);
      } else {
        const ev: AutorunEvent = {
          kind: "skipped",
          ts: now(),
          change: decision.brief.frontmatter.change,
          reason: decision.reason,
          ...(decision.detail ? { detail: decision.detail } : {}),
        };
        emit(ev);
        renderer?.onEvent(ev);
      }
    }
  };

  let watcher: FSWatcher | undefined;
  let watchDebounce: NodeJS.Timeout | undefined;
  const setupWatch = (): void => {
    if (resolved.dryRun || resolved.once) return;
    try {
      watcher = watch(resolved.watch, { persistent: false }, () => {
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          wakeUp?.();
        }, 250);
      });
      watcher.on("error", () => {
        // Best-effort; fall back to polling cadence.
      });
    } catch (err) {
      if (resolved.json) {
        emit({
          kind: "info",
          ts: now(),
          message: `fs.watch unavailable: ${(err as Error).message}; polling only`,
        });
      }
    }
  };

  let exitCode = 0;
  try {
    if (resolved.dryRun) {
      await pollOnce(true);
      return 0;
    }

    setupWatch();
    await pollOnce(false);

    if (resolved.once) {
      await drainOrEscalate();
      return forceRequested && scheduler.anyKilled() ? 2 : 0;
    }

    while (!stopRequested) {
      await sleepUntil(
        resolved.interval,
        () => {
          wakeUp = undefined;
        },
        (resolve) => {
          wakeUp = resolve;
        },
      );
      if (stopRequested) break;
      await pollOnce(false);
    }

    await drainOrEscalate();
    exitCode = forceRequested && scheduler.anyKilled() ? 2 : 0;
  } finally {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // best effort
      }
    }
    if (watchDebounce) clearTimeout(watchDebounce);
    uninstallSignals();
    if (renderer) {
      try {
        renderer.unmount();
      } catch {
        // best effort
      }
      renderer = null;
    }
    try {
      await store.close();
    } catch {
      // best effort
    }
  }

  return exitCode;

  async function drainOrEscalate(): Promise<void> {
    if (forceRequested) {
      scheduler.killAllInFlight();
    }
    await scheduler.drain();
    // After all in-flight runs settle, in-flight auto-merge work may
    // still be chained on `mergeQueue` because completions enqueue merge
    // work in the scheduler's onCompleted callback. Awaiting `mergeQueue`
    // ensures `--once` (and quit-driven exits) don't return before
    // merges and mark-done calls finish.
    await mergeQueue.catch(() => undefined);
  }
}

function emitDryRunDecision(
  decision: SchedulerDecision,
  emit: (event: AutorunEvent) => void,
  now: () => number,
): void {
  if (decision.action === "schedule") {
    emit({
      kind: "dry-run-decision",
      ts: now(),
      change: decision.brief.frontmatter.change,
      action: "schedule",
    });
  } else {
    emit({
      kind: "dry-run-decision",
      ts: now(),
      change: decision.brief.frontmatter.change,
      action: "skip",
      reason: decision.reason,
      ...(decision.detail ? { detail: decision.detail } : {}),
    });
  }
}

function installDefaultSignalHandlers(handler: () => void): () => void {
  const onSig = (): void => {
    handler();
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);
  return () => {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  };
}

function sleepUntil(
  ms: number,
  reset: () => void,
  setWaker: (wake: () => void) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      reset();
      resolve();
    }, ms);
    const wake = (): void => {
      clearTimeout(timer);
      reset();
      resolve();
    };
    setWaker(wake);
  });
}
