import { spawn } from "node:child_process";
import { markBriefDone } from "../runner/mark-done.js";
import type { RunStore, StoredRun } from "../storage/run-store.js";
import { gitDefaultBranch } from "../worktree/git.js";

export type AutoMergeFailReason =
  | "conflict"
  | "non-fast-forward"
  | "dirty-working-tree"
  | "no-default-branch"
  | "null-branch-name"
  | "other";

export type MergeOutcome =
  | { ok: true; headSha: string; defaultBranch: string; branchName: string }
  | { ok: false; reason: AutoMergeFailReason; message: string };

export interface MergeRunOptions {
  ffOnly?: boolean;
  cwd: string;
  /** Override the default branch resolver (tests). */
  resolveDefaultBranch?: (repoCwd: string) => Promise<string | undefined>;
  /** Override how shell-outs run (tests). */
  spawnGit?: SpawnGit;
}

export interface RunMergeOptions {
  arg: string;
  ffOnly?: boolean;
  pick?: boolean;
  force?: boolean;
  store: RunStore;
  cwd: string;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Override the default branch resolver (tests). */
  resolveDefaultBranch?: (repoCwd: string) => Promise<string | undefined>;
  /** Override how shell-outs run (tests). */
  spawnGit?: SpawnGit;
  /** Override the mark-done helper (tests). Default = real `markBriefDone`. */
  markBriefDoneFn?: typeof markBriefDone;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type SpawnGit = (cwd: string, args: readonly string[]) => Promise<GitRunResult>;

const HEX_RE = /^[0-9a-f]+$/i;

/**
 * Perform the merge sequence for a resolved run row. This is the underlying
 * primitive shared between the operator-driven `runMerge` (CLI) and the
 * autorun wrapper's auto-merge step. Returns a structured outcome instead
 * of writing to stdout/stderr so the caller can map it to its own contract
 * (CLI exit code + stderr line, or autorun event payload).
 */
export async function mergeRun(row: StoredRun, opts: MergeRunOptions): Promise<MergeOutcome> {
  const spawnGit = opts.spawnGit ?? defaultSpawnGit;
  const resolveDefault = opts.resolveDefaultBranch ?? ((c) => gitDefaultBranch(c));

  if (!row.branchName) {
    return {
      ok: false,
      reason: "null-branch-name",
      message: `Run \`${row.id}\` predates per-run branch naming (no branch_name persisted). If a branch matching its change still exists, merge it manually with \`git merge ${row.change ?? "<change>"}\`.`,
    };
  }
  const branch = row.branchName;

  const defaultBranch = await resolveDefault(opts.cwd);
  if (!defaultBranch) {
    return {
      ok: false,
      reason: "no-default-branch",
      message:
        "Could not resolve a default branch (no configured default, no origin/HEAD, no local `main`).",
    };
  }

  const status = await spawnGit(opts.cwd, ["status", "--porcelain"]);
  if (status.exitCode !== 0) {
    return {
      ok: false,
      reason: "other",
      message: `\`git status --porcelain\` failed: ${status.stderr.trim()}`,
    };
  }
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      reason: "dirty-working-tree",
      message:
        "Working tree is not clean — refusing to merge. Commit, discard, or `git stash` your changes and retry.",
    };
  }

  const head = await spawnGit(opts.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const currentBranch = head.exitCode === 0 ? head.stdout.trim() : "";
  if (currentBranch !== defaultBranch) {
    const co = await spawnGit(opts.cwd, ["checkout", defaultBranch]);
    if (co.exitCode !== 0) {
      return {
        ok: false,
        reason: "other",
        message: `Failed to checkout \`${defaultBranch}\`: ${co.stderr.trim()}`,
      };
    }
  }

  const ff = await spawnGit(opts.cwd, ["merge", "--ff-only", branch]);
  if (ff.exitCode === 0) {
    const sha = await spawnGit(opts.cwd, ["rev-parse", "HEAD"]);
    return { ok: true, headSha: sha.stdout.trim(), defaultBranch, branchName: branch };
  }

  if (opts.ffOnly) {
    return {
      ok: false,
      reason: "non-fast-forward",
      message: `Fast-forward merge of \`${branch}\` into \`${defaultBranch}\` failed: ${ff.stderr.trim() || "non-fast-forward"}`,
    };
  }

  const mc = await spawnGit(opts.cwd, ["merge", "--no-ff", "-m", `Merge ${branch}`, branch]);
  if (mc.exitCode === 0) {
    const sha = await spawnGit(opts.cwd, ["rev-parse", "HEAD"]);
    return { ok: true, headSha: sha.stdout.trim(), defaultBranch, branchName: branch };
  }

  // Conflict — abort and list paths.
  await spawnGit(opts.cwd, ["merge", "--abort"]);
  const conflicts = await spawnGit(opts.cwd, ["diff", "--name-only", "--diff-filter=U"]);
  const paths = conflicts.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let message = `Merge of \`${branch}\` into \`${defaultBranch}\` produced conflicts; aborted.`;
  if (paths.length > 0) {
    message += `\nConflicting paths:\n${paths.map((p) => `  ${p}`).join("\n")}`;
  }
  return { ok: false, reason: "conflict", message };
}

export async function runMerge(opts: RunMergeOptions): Promise<number> {
  const { arg, store, stdout, stderr } = opts;

  const resolved = await resolveRun(arg, opts);
  if (!resolved.ok) {
    stderr.write(`${resolved.message}\n`);
    return 1;
  }
  const row = resolved.row;

  const mergeOpts: MergeRunOptions = {
    cwd: opts.cwd,
    ...(opts.ffOnly !== undefined ? { ffOnly: opts.ffOnly } : {}),
    ...(opts.resolveDefaultBranch ? { resolveDefaultBranch: opts.resolveDefaultBranch } : {}),
    ...(opts.spawnGit ? { spawnGit: opts.spawnGit } : {}),
  };
  const outcome = await mergeRun(row, mergeOpts);

  if (!outcome.ok) {
    stderr.write(`${outcome.message}\n`);
    return 1;
  }

  stdout.write(
    `Merged \`${outcome.branchName}\` into \`${outcome.defaultBranch}\` at ${outcome.headSha}\n`,
  );

  // Mark-done post-step: invoke only when the operator resolved the run by
  // change name (not by raw run-id prefix). See the change's design doc,
  // "Decisions" → "`minifac merge` calls mark-done on success — but only
  // on the change-by-name path".
  if (resolved.path === "change-name" && row.change) {
    try {
      const markFn = opts.markBriefDoneFn ?? markBriefDone;
      const res = await markFn({ change: row.change, runCwd: opts.cwd });
      if (res.warning) {
        stderr.write(`${res.warning}\n`);
      }
    } catch (err) {
      stderr.write(`mark-done: unexpected error: ${(err as Error).message}\n`);
    }
  }

  return 0;
}

interface ResolveOk {
  ok: true;
  row: StoredRun;
  path: "run-id-prefix" | "change-name";
}
interface ResolveErr {
  ok: false;
  message: string;
}

async function resolveRun(arg: string, opts: RunMergeOptions): Promise<ResolveOk | ResolveErr> {
  const { store, stdin, stdout } = opts;
  const allowNonSucceeded = opts.force === true;

  if (HEX_RE.test(arg) && arg.length >= 6) {
    const rows = await store.listRuns({ limit: 1000 });
    const matches = rows.filter((r) => r.id.startsWith(arg.toLowerCase()));
    if (matches.length === 1) {
      const row = matches[0] as StoredRun;
      if (!allowNonSucceeded && row.status !== "succeeded") {
        return {
          ok: false,
          message: `Run \`${row.id}\` has status \`${row.status}\`; pass --force to merge a non-succeeded run.`,
        };
      }
      return { ok: true, row, path: "run-id-prefix" };
    }
    if (matches.length > 1) {
      const ids = matches.map((m) => m.id).join(", ");
      return { ok: false, message: `Run-id prefix \`${arg}\` is ambiguous; matches: ${ids}` };
    }
    // Fall through to change-name resolution if hex didn't match exactly one row.
  }

  const rows = await store.listRuns({ change: arg, limit: 1000 });
  const filtered = allowNonSucceeded ? rows : rows.filter((r) => r.status === "succeeded");
  if (filtered.length === 0) {
    if (rows.length === 0) {
      return {
        ok: false,
        message: `No runs match change \`${arg}\` (or run-id prefix \`${arg}\`).`,
      };
    }
    return {
      ok: false,
      message: `No succeeded runs for change \`${arg}\`. Pass --force to merge a non-succeeded run.`,
    };
  }
  if (filtered.length === 1) {
    return { ok: true, row: filtered[0] as StoredRun, path: "change-name" };
  }

  if (!opts.pick) {
    const ids = filtered
      .map((r) => `  ${r.id.slice(0, 8)}  ${r.status}  ${r.branchName ?? "-"}`)
      .join("\n");
    return {
      ok: false,
      message: `Multiple succeeded runs for change \`${arg}\`. Pass --pick or a run-id prefix:\n${ids}`,
    };
  }

  // --pick prompt.
  stdout.write(`Multiple runs for change \`${arg}\`. Pick one:\n`);
  filtered.forEach((r, i) => {
    const started = new Date(r.startedAt).toISOString();
    stdout.write(
      `  ${i + 1}) ${r.id.slice(0, 8)}  ${r.status}  ${r.branchName ?? "-"}  ${started}\n`,
    );
  });
  stdout.write("Selection: ");
  const line = await readOneLine(stdin);
  if (line === null || line.trim().length === 0) {
    return { ok: false, message: "No selection — aborting." };
  }
  const n = Number.parseInt(line.trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > filtered.length) {
    return { ok: false, message: `Invalid selection \`${line.trim()}\`.` };
  }
  return { ok: true, row: filtered[n - 1] as StoredRun, path: "change-name" };
}

function readOneLine(stream: NodeJS.ReadableStream): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = "";
    let resolved = false;
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0 && !resolved) {
        resolved = true;
        cleanup();
        resolve(buf.slice(0, nl));
      }
    };
    const onEnd = (): void => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(buf.length > 0 ? buf : null);
      }
    };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onEnd);
  });
}

const defaultSpawnGit: SpawnGit = (cwd, args) =>
  new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => outChunks.push(b));
    child.stderr.on("data", (b: Buffer) => errChunks.push(b));
    child.on("error", (err) => {
      resolve({ stdout: "", stderr: (err as Error).message, exitCode: null });
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
