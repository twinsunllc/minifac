import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type Brief, BriefLoadError, loadBrief } from "../brief/loader.js";
import type { ExecutorRegistry } from "../executor/registry.js";
import { openDefaultRunStore } from "../storage/open.js";
import type { RunStore } from "../storage/run-store.js";
import { type AutorunFilter, AutorunFilterError, parseAutorunFilter } from "./autorun-filter.js";
import {
  type AutorunRunFactory,
  type RunFactoryArgs,
  Scheduler,
  type SchedulerDecision,
  type SkipReason,
} from "./autorun-scheduler.js";
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
}

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
    },
  };
}

function buildDefaultRunFactory(
  cwd: string,
  store: RunStore | undefined,
  buildRegistry: (() => ExecutorRegistry) | undefined,
): AutorunRunFactory {
  return (args: RunFactoryArgs) => {
    const ac = new AbortController();
    const promise = runBriefAutomated({
      brief: args.brief,
      cwd,
      ...(store ? { store } : {}),
      abortSignal: ac.signal,
      ...(buildRegistry ? { buildRegistry } : {}),
    }).then((result) => ({
      status: result.status,
      runId: result.runId,
      ...(result.reason ? { reason: result.reason } : {}),
    }));
    return {
      promise,
      child: {
        kill(_signal?: NodeJS.Signals) {
          // The default factory has no spawned child handle to SIGTERM —
          // the runner runs in-process. Aborting the AbortController is the
          // closest analogue; the runner short-circuits on its next yielded
          // event.
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

  logger.log({
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

  const runFactory = input.runFactory ?? buildDefaultRunFactory(cwd, store, input.buildRegistry);

  const scheduler = new Scheduler({
    runFactory,
    runStore: store,
    inputsDir: resolved.watch,
    repoRoot: cwd,
    maxConcurrent: resolved.maxConcurrent,
    callbacks: {
      onStarted(event) {
        logger.log({
          kind: "started",
          ts: now(),
          change: event.change,
          ...(event.runId ? { runId: event.runId } : {}),
        });
      },
      onCompleted(event) {
        logger.log({
          kind: "completed",
          ts: now(),
          change: event.change,
          status: event.status,
          ...(event.runId ? { runId: event.runId } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        });
      },
      onError(change, err) {
        logger.log({
          kind: "info",
          ts: now(),
          message: `run error for ${change}: ${err.message}`,
        });
      },
    },
  });

  let stopRequested = false;
  let forceRequested = resolved.force;
  let wakeUp: (() => void) | undefined;

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
    logger.log({ kind: "poll-start", ts: now(), briefs: briefs.length });
    for (const b of briefs) {
      if (stopRequested && !dryRun) break;
      const decision = await scheduler.decide(b.brief, resolved.filter);
      if (dryRun) {
        emitDryRunDecision(logger, now, decision);
        continue;
      }
      if (decision.action === "schedule") {
        scheduler.start(decision.brief);
      } else {
        logger.log({
          kind: "skipped",
          ts: now(),
          change: decision.brief.frontmatter.change,
          reason: decision.reason,
          ...(decision.detail ? { detail: decision.detail } : {}),
        });
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
        logger.log({
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
  }
}

function emitDryRunDecision(
  logger: AutorunLogger,
  now: () => number,
  decision: SchedulerDecision,
): void {
  if (decision.action === "schedule") {
    logger.log({
      kind: "dry-run-decision",
      ts: now(),
      change: decision.brief.frontmatter.change,
      action: "schedule",
    });
  } else {
    logger.log({
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
