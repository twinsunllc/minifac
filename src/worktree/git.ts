import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawn `git` with the given args in `cwd` and return the captured output.
 * Never throws; non-zero exits and spawn errors surface in the returned
 * struct so callers can branch on `exitCode`. Shared with
 * `src/brief/cleanliness.ts` so the cleanliness probe reuses the same
 * git-subprocess shape as the rest of the worktree code.
 */
export function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return run(cwd, args);
}

function run(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => outChunks.push(b));
    child.stderr.on("data", (b: Buffer) => errChunks.push(b));
    child.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: (err as Error).message,
        exitCode: null,
      });
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

async function runOrThrow(cwd: string, args: readonly string[]): Promise<string> {
  const res = await run(cwd, args);
  if (res.exitCode !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
      `git ${args.join(" ")}`,
      res.stderr,
      res.exitCode,
    );
  }
  return res.stdout;
}

export async function gitRemoteOriginUrl(repoCwd: string): Promise<string> {
  const res = await run(repoCwd, ["config", "--get", "remote.origin.url"]);
  // Exit code 1 (and empty stdout) is the documented "not set" state.
  if (res.exitCode === 0) return res.stdout.trim();
  return "";
}

export async function gitRevParseHead(repoCwd: string): Promise<string> {
  return (await runOrThrow(repoCwd, ["rev-parse", "HEAD"])).trim();
}

export async function gitRevParseToplevel(repoCwd: string): Promise<string> {
  return (await runOrThrow(repoCwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function gitWorktreeAdd(
  repoCwd: string,
  dir: string,
  branch: string,
  baseRev: string,
): Promise<void> {
  await runOrThrow(repoCwd, ["worktree", "add", "-b", branch, dir, baseRev]);
}

export async function gitWorktreeRemoveForce(repoCwd: string, dir: string): Promise<void> {
  await runOrThrow(repoCwd, ["worktree", "remove", "--force", dir]);
}

export async function gitWorktreePrune(repoCwd: string): Promise<void> {
  await runOrThrow(repoCwd, ["worktree", "prune"]);
}

/**
 * Delete a local branch ref. Force-deletes by default (-D); the only
 * caller is `minifac prune`, which has already removed the worktree and
 * thus opted into discarding the branch even if its tip was unmerged.
 */
export async function gitBranchDelete(
  repoCwd: string,
  branch: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const flag = opts.force === false ? "-d" : "-D";
  await runOrThrow(repoCwd, ["branch", flag, branch]);
}

/**
 * Resolve the default branch of `repoCwd`:
 * 1. `configuredDefault` (when set)
 * 2. The branch that `origin/HEAD` points to
 * 3. `main`
 *
 * Returns `undefined` only when neither `origin/HEAD` resolves nor a `main`
 * branch exists locally — callers degrade the prune policy to "always keep"
 * in that case.
 */
export async function gitDefaultBranch(
  repoCwd: string,
  configuredDefault?: string,
): Promise<string | undefined> {
  if (configuredDefault && configuredDefault.length > 0) return configuredDefault;
  const symbolic = await run(repoCwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (symbolic.exitCode === 0) {
    const trimmed = symbolic.stdout.trim();
    // Typical output: "origin/main"
    const slash = trimmed.indexOf("/");
    if (slash >= 0) return trimmed.slice(slash + 1);
    if (trimmed.length > 0) return trimmed;
  }
  const mainCheck = await run(repoCwd, ["rev-parse", "--verify", "main"]);
  if (mainCheck.exitCode === 0) return "main";
  return undefined;
}

/**
 * True if `branch` is reachable from `defaultBranch` via `git branch --merged`
 * OR a squash-merge subject heuristic.
 */
export async function gitBranchMerged(
  repoCwd: string,
  branch: string,
  defaultBranch: string,
  options: { skipSquashHeuristic?: boolean } = {},
): Promise<boolean> {
  // Fast path: `git branch --merged <default>` lists branches whose tip is
  // reachable from <default>'s tip.
  const merged = await run(repoCwd, ["branch", "--merged", defaultBranch]);
  if (merged.exitCode === 0) {
    const lines = merged.stdout
      .split(/\r?\n/)
      .map((l) => l.replace(/^[*+\s]+/, "").trim())
      .filter((l) => l.length > 0);
    if (lines.includes(branch)) return true;
  }

  if (options.skipSquashHeuristic) return false;

  // Squash-merge heuristic: if the branch's tip subject appears in the recent
  // history of <default>, treat as merged. Catches the squash-merge case
  // where the original commits don't survive but the subject was preserved.
  const tipSubject = await run(repoCwd, ["log", "-1", "--pretty=%s", branch]);
  if (tipSubject.exitCode !== 0) return false;
  const subject = tipSubject.stdout.trim();
  if (subject.length === 0) return false;
  const search = await run(repoCwd, ["log", "--pretty=%s", "-n", "200", defaultBranch]);
  if (search.exitCode !== 0) return false;
  const defaultSubjects = search.stdout.split(/\r?\n/).map((l) => l.trim());
  return defaultSubjects.includes(subject);
}
