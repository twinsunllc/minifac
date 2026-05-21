import { createHash } from "node:crypto";
import path from "node:path";
import type { WorktreeConfig } from "./config.js";
import { gitRemoteOriginUrl } from "./git.js";

/**
 * 8 lowercase hex chars of `sha256(repo-identity)` where `repo-identity` is
 * the trimmed `git remote.origin.url` when non-empty, else the absolute
 * `repoRoot`. Two checkouts of the same remote collide on purpose; repos
 * without a remote disambiguate by their on-disk location.
 */
export async function computeRepoHash(repoRoot: string): Promise<string> {
  let identity = "";
  try {
    identity = (await gitRemoteOriginUrl(repoRoot)).trim();
  } catch {
    identity = "";
  }
  if (identity.length === 0) {
    identity = path.resolve(repoRoot);
  }
  return createHash("sha256").update(identity).digest("hex").slice(0, 8);
}

export function worktreeKeyForBrief(repoHash: string, change: string): string {
  return `${repoHash}-${change}`;
}

export function worktreeKeyForFactory(
  repoHash: string,
  factoryName: string,
  timestamp: number,
): string {
  return `${repoHash}-${factoryName}-${timestamp.toString(36)}`;
}

export function worktreePathForKey(config: WorktreeConfig, key: string): string {
  return path.join(config.worktreesDir, key);
}

export function lockPathForKey(config: WorktreeConfig, key: string): string {
  return path.join(config.locksDir, `${key}.lock`);
}

/**
 * 6 lowercase hex chars of the run id (UUID). Used as the per-run
 * disambiguator inside the per-change branch and worktree-directory
 * namespace. See `docs/decisions/0019-Run-Scoped-Branches.md`.
 */
export function runSlugFromId(runId: string): string {
  return runId.slice(0, 6).toLowerCase();
}

/**
 * Branch name for a run: `run/<segment>-<slug>` where `segment` is the
 * brief's `change` (brief-driven) or the factory name (brief-less).
 */
export function runBranchName(changeOrFactory: string, slug: string): string {
  return `run/${changeOrFactory}-${slug}`;
}

/**
 * Worktree directory leaf for a run: `run-<segment>-<slug>`. Mirrors the
 * branch name with the path separator swapped so the directory leaf is
 * a single path component on every filesystem.
 */
export function runWorktreeDirName(changeOrFactory: string, slug: string): string {
  return `run-${changeOrFactory}-${slug}`;
}

/** Absolute path under `config.worktreesDir` for a given run-directory leaf. */
export function runWorktreePathForDir(config: WorktreeConfig, dirName: string): string {
  return path.join(config.worktreesDir, dirName);
}
