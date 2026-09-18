/**
 * `minifac run --resume <run> --at <node> [--feedback <file>]`.
 *
 * Continues a finished run at one node with the human's answer as feedback.
 * Everything about it is deliberately NOT a new run: the run id, the
 * worktree, the branch and the per-node results are the parked run's, and
 * the resumed dispatches append to the same `runs` row. See
 * `docs/decisions/0042-Resume-At-Node.md`.
 */

import { readFile, stat } from "node:fs/promises";
import type { Brief } from "../brief/loader.js";
import type { ExecutorRegistry } from "../executor/registry.js";
import type { EmittedEvent } from "../executor/types.js";
import { loadFactory } from "../factory/loader.js";
import type { RunResult } from "../runner/result.js";
import { ResumeStateError, resumeStateFromStore } from "../runner/resume.js";
import { runFactory } from "../runner/run.js";
import type { RunStore, StoredRun } from "../storage/run-store.js";

/** Shortest run-id prefix `--resume` accepts, matching `minifac merge`. */
const MIN_PREFIX_LENGTH = 6;
/** A run id is a UUID, so hyphens are part of the alphabet: an operator who
 * copies the whole id out of `minifac runs` must not be told it is not one. */
const RUN_REF_RE = /^[0-9a-fA-F-]+$/;

export interface ResumeRunOptions {
  /** The `--resume` argument: a run id or a prefix of at least 6 hex chars. */
  runRef: string;
  /** The `--at` argument. Required; a resume with no node is not a resume. */
  at?: string;
  /** The `--feedback` argument: a path to the answer's text. */
  feedbackPath?: string;
  cwd: string;
  store: RunStore;
  registry: ExecutorRegistry;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  onEvent?: (entry: EmittedEvent) => void;
  /** Injected in tests so the resume path can be exercised without a real
   * factory dispatch. Defaults to the real runner. */
  runFactoryFn?: typeof runFactory;
  /** Injected in tests; defaults to `loadBrief` from `../brief/loader.js`. */
  loadBriefFn?: (change: string, cwd: string) => Promise<Brief>;
}

/**
 * Run the resume. Returns the process exit code.
 *
 * Every refusal is a sentence naming the problem and a non-zero code: an
 * operator answering an ask in a terminal must be told which of the four
 * things they typed was wrong, not handed a stack trace.
 */
export async function resumeRunAction(options: ResumeRunOptions): Promise<number> {
  const { runRef, cwd, store, stderr, stdout } = options;

  if (!options.at || options.at.length === 0) {
    stderr.write("--resume requires --at <node>: a resume has to name the node to resume at.\n");
    return 1;
  }
  const at = options.at;

  const resolved = await resolveRun(store, runRef);
  if (!resolved.ok) {
    stderr.write(`${resolved.message}\n`);
    return 1;
  }
  const row = resolved.row;

  // The parked run's worktree IS the workspace: its commits, its branch and
  // its PRs are what "keeping the branch" means. A missing one is refused
  // rather than silently replaced with the caller's cwd, which would resume
  // the run against a tree that never saw its work.
  let runCwd = cwd;
  if (row.worktreePath !== null && row.worktreePath.length > 0) {
    try {
      const st = await stat(row.worktreePath);
      if (!st.isDirectory()) throw new Error("not a directory");
    } catch {
      stderr.write(
        `Run \`${row.id}\` recorded its worktree at ${row.worktreePath}, which is gone. Resuming would run the node against a tree that never saw the run's work; restore the worktree or re-run the factory from the start.\n`,
      );
      return 1;
    }
    runCwd = row.worktreePath;
  }

  let feedback: string | undefined;
  if (options.feedbackPath !== undefined) {
    try {
      feedback = await readFile(options.feedbackPath, "utf8");
    } catch (err) {
      stderr.write(
        `Could not read the feedback file ${options.feedbackPath}: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  let loaded: Awaited<ReturnType<typeof loadFactory>>;
  try {
    loaded = await loadFactory(row.factoryPath, cwd);
  } catch (err) {
    stderr.write(
      `Could not load the factory this run used (${row.factoryPath}): ${(err as Error).message}\n`,
    );
    return 1;
  }

  // Refused HERE as well as in the runner. The runner's own check is what
  // makes the guarantee true of every caller; this one is what makes the
  // message a CLI message, before anything is reopened or dispatched.
  if (!loaded.factory.nodes[at]) {
    const known = Object.keys(loaded.factory.nodes).join(", ") || "none";
    stderr.write(
      `\`--at ${at}\` names no node in factory \`${loaded.factory.name}\` (nodes: ${known}).\n`,
    );
    return 1;
  }

  let resumeState: Awaited<ReturnType<typeof resumeStateFromStore>>;
  try {
    resumeState = await resumeStateFromStore({
      store,
      runId: row.id,
      at,
      ...(feedback !== undefined ? { feedback } : {}),
    });
  } catch (err) {
    if (err instanceof ResumeStateError) {
      stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  // The brief the parked run ran against, so `{{ brief.* }}` in the resumed
  // node's prompt still binds. Best-effort: a brief that has since been
  // archived (mark-done moves it to `inputs/done/`) is a warning, not a
  // refusal — the answer is still worth delivering.
  let brief: Brief | undefined;
  if (row.change !== null && row.change.length > 0) {
    const loadBriefFn = options.loadBriefFn ?? (await import("../brief/loader.js")).loadBrief;
    try {
      brief = await loadBriefFn(row.change, cwd);
    } catch (err) {
      stderr.write(
        `Warning: could not reload brief \`${row.change}\`: ${(err as Error).message}; \`{{ brief.* }}\` tokens in the resumed node's prompt will pass through verbatim.\n`,
      );
    }
  }

  stdout.write(
    `Resuming run ${row.id.slice(0, 8)} (${row.factoryName}) at node \`${at}\`` +
      `${resumeState.priorResults.length > 0 ? ` with ${resumeState.priorResults.length} prior node result(s)` : ""}` +
      `${feedback !== undefined ? " and a human answer" : ""}.\n`,
  );

  const runFactoryFn = options.runFactoryFn ?? runFactory;
  const result: RunResult = await runFactoryFn(loaded, {
    registry: options.registry,
    store,
    // The ORIGINAL id: the resumed dispatches are this run's, and the
    // `runs` row is reopened rather than duplicated.
    runId: row.id,
    runCwd,
    ...(row.baseBranch !== null ? { runBaseBranch: row.baseBranch } : {}),
    ...(row.branchName !== null ? { branchName: row.branchName } : {}),
    ...(brief ? { brief } : {}),
    resume: resumeState,
    // The resumed segment must not fire mark-done: the change's doneness is
    // the whole run's question, and the human answered one node of it.
    skipMarkDone: true,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  if (result.status === "succeeded") {
    stderr.write(`[run] succeeded cwd=${runCwd}\n`);
    return 0;
  }

  stderr.write(
    `Run failed: ${result.reason}${result.proximateNodeId ? ` at node "${result.proximateNodeId}"` : ""}\n`,
  );
  stderr.write(`[run] failed cwd=${runCwd}\n`);
  return result.reason === "budget_exhausted" ? 3 : 2;
}

type ResolveOutcome = { ok: true; row: StoredRun } | { ok: false; message: string };

/**
 * Resolve `--resume` to one run row.
 *
 * By run-id prefix only, unlike `minifac merge`'s change-name fallback: a
 * change may have many runs and the one being resumed is a specific parked
 * attempt, so guessing which is worse than asking. Status is not filtered —
 * a parked run is a FAILED run, and refusing to resume it would refuse
 * every case this exists for.
 */
async function resolveRun(store: RunStore, arg: string): Promise<ResolveOutcome> {
  if (!RUN_REF_RE.test(arg) || arg.length < MIN_PREFIX_LENGTH) {
    return {
      ok: false,
      message:
        `\`${arg}\` is not a run id or a run-id prefix; --resume takes at least ` +
        `${MIN_PREFIX_LENGTH} hex characters of a run id (see \`minifac runs\`).`,
    };
  }
  const rows = await store.listRuns({ limit: 1000 });
  const matches = rows.filter((r) => r.id.startsWith(arg.toLowerCase()));
  if (matches.length === 1) return { ok: true, row: matches[0] as StoredRun };
  if (matches.length === 0) {
    return { ok: false, message: `No run matches run-id prefix \`${arg}\`.` };
  }
  const ids = matches.map((m) => m.id).join(", ");
  return { ok: false, message: `Run-id prefix \`${arg}\` is ambiguous; matches: ${ids}` };
}
