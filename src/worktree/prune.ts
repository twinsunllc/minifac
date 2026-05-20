import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { WorktreeConfig } from "./config.js";
import {
  gitBranchMerged,
  gitDefaultBranch,
  gitWorktreePrune,
  gitWorktreeRemoveForce,
} from "./git.js";
import { readFailedRuns } from "./journal.js";

export type Classification = "fresh" | "merged-old" | "unmerged-old" | "failed";

export interface PruneOptions {
  all?: boolean;
  merged?: boolean;
  olderThan?: { value: number; unit: "m" | "h" | "d" };
  failed?: boolean;
  lazy?: boolean;
  budgetMs?: number;
}

export interface PruneCounts {
  removed: Record<Classification, number>;
  kept: Record<Classification, number>;
  errors: { dir: string; message: string }[];
}

function emptyCounts(): PruneCounts {
  return {
    removed: { fresh: 0, "merged-old": 0, "unmerged-old": 0, failed: 0 },
    kept: { fresh: 0, "merged-old": 0, "unmerged-old": 0, failed: 0 },
    errors: [],
  };
}

function cutoffMillisFromOpts(opts: PruneOptions): number {
  const def = 7 * 24 * 60 * 60 * 1000; // 7 days
  if (!opts.olderThan) return def;
  const { value, unit } = opts.olderThan;
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

interface ClassifyContext {
  failedDirs: Set<string>;
  defaultBranch: string | undefined;
  callerRepoCwd: string;
  cutoffMs: number;
  now: number;
  skipSquashHeuristic: boolean;
}

async function readBranchName(worktreeDir: string): Promise<string | undefined> {
  // worktree's `.git` is a file pointing at the main repo's `gitdir/worktrees/<name>`.
  // Reading `<worktreeDir>/.git/HEAD` won't work; instead read `HEAD` via the
  // gitdir pointer. Simpler: read `<worktreeDir>/.git` (file), follow the
  // gitdir reference, then read `<gitdir>/HEAD`.
  try {
    const gitFile = path.join(worktreeDir, ".git");
    const s = await stat(gitFile);
    let headPath: string;
    if (s.isDirectory()) {
      headPath = path.join(gitFile, "HEAD");
    } else {
      const content = (await readFile(gitFile, "utf8")).trim();
      const prefix = "gitdir:";
      if (!content.startsWith(prefix)) return undefined;
      const gitdir = content.slice(prefix.length).trim();
      const resolved = path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreeDir, gitdir);
      headPath = path.join(resolved, "HEAD");
    }
    const head = (await readFile(headPath, "utf8")).trim();
    const m = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

export async function classifyWorktree(
  worktreeDir: string,
  ctx: ClassifyContext,
): Promise<Classification> {
  if (ctx.failedDirs.has(worktreeDir)) return "failed";
  const s = await stat(worktreeDir);
  const ageMs = ctx.now - s.mtimeMs;
  if (ageMs < ctx.cutoffMs) return "fresh";
  if (!ctx.defaultBranch) return "unmerged-old";
  const branch = await readBranchName(worktreeDir);
  if (!branch) return "unmerged-old";
  try {
    const merged = await gitBranchMerged(ctx.callerRepoCwd, branch, ctx.defaultBranch, {
      skipSquashHeuristic: ctx.skipSquashHeuristic,
    });
    return merged ? "merged-old" : "unmerged-old";
  } catch {
    return "unmerged-old";
  }
}

function noSelectorFlags(opts: PruneOptions): boolean {
  // True when the caller supplied no selection-affecting flag at all. The
  // no-flag default behaves like `--merged` (remove only `merged-old`).
  return !opts.all && !opts.merged && !opts.failed;
}

function shouldRemove(cls: Classification, opts: PruneOptions): boolean {
  if (cls === "failed") return opts.failed === true;
  if (cls === "merged-old") {
    return opts.merged === true || opts.all === true || noSelectorFlags(opts);
  }
  if (cls === "unmerged-old") return opts.all === true;
  if (cls === "fresh") return opts.all === true;
  return false;
}

async function removeWorktree(callerRepoCwd: string, dir: string): Promise<void> {
  try {
    await gitWorktreeRemoveForce(callerRepoCwd, dir);
    return;
  } catch {
    // Fall through to rm + prune.
  }
  await rm(dir, { recursive: true, force: true });
  try {
    await gitWorktreePrune(callerRepoCwd);
  } catch {
    // best effort
  }
}

export interface PruneInput {
  config: WorktreeConfig;
  callerRepoCwd: string;
  options: PruneOptions;
  /** Override "now" for deterministic tests. */
  now?: number;
}

export async function pruneWorktrees(input: PruneInput): Promise<PruneCounts> {
  const counts = emptyCounts();
  const { config, callerRepoCwd, options } = input;
  const now = input.now ?? Date.now();

  let entries: string[];
  try {
    entries = await readdir(config.worktreesDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return counts;
    throw err;
  }

  const failed = await readFailedRuns();
  const failedDirs = new Set(
    failed.filter((f) => f.status !== "succeeded").map((f) => f.worktreeDir),
  );

  let defaultBranch: string | undefined;
  try {
    defaultBranch = await gitDefaultBranch(callerRepoCwd, config.defaultBranch);
  } catch {
    defaultBranch = undefined;
  }

  const cutoffMs = cutoffMillisFromOpts(options);
  const ctx: ClassifyContext = {
    failedDirs,
    defaultBranch,
    callerRepoCwd,
    cutoffMs,
    now,
    skipSquashHeuristic: options.lazy === true,
  };

  const startedAt = Date.now();
  const budgetMs = options.lazy ? (options.budgetMs ?? 200) : Number.POSITIVE_INFINITY;

  for (const name of entries) {
    if (Date.now() - startedAt > budgetMs) break;
    const dir = path.join(config.worktreesDir, name);
    let cls: Classification;
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      cls = await classifyWorktree(dir, ctx);
    } catch {
      continue;
    }
    if (shouldRemove(cls, options)) {
      try {
        await removeWorktree(callerRepoCwd, dir);
        counts.removed[cls] += 1;
      } catch (err) {
        counts.errors.push({ dir, message: (err as Error).message });
        counts.kept[cls] += 1;
      }
    } else {
      counts.kept[cls] += 1;
    }
  }

  return counts;
}

/** Parse a `--older-than` value like `7d`, `12h`, `30m`. */
export function parseOlderThan(input: string): { value: number; unit: "m" | "h" | "d" } {
  const m = input.match(/^(\d+)([mhd])$/);
  if (!m) {
    throw new Error(
      `Invalid --older-than value \`${input}\`: expected <int><m|h|d> (e.g. 7d, 12h, 30m)`,
    );
  }
  return { value: Number.parseInt(m[1] as string, 10), unit: m[2] as "m" | "h" | "d" };
}
