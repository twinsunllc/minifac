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
