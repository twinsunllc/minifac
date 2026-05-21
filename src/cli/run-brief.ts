import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Brief } from "../brief/loader.js";
import { ClaudeExecutor } from "../executor/claude.js";
import { ExecutorRegistry } from "../executor/registry.js";
import { type LoadedFactory, loadFactory } from "../factory/loader.js";
import { runFactory } from "../runner/run.js";
import type { RunStore } from "../storage/run-store.js";
import { loadWorktreeConfig } from "../worktree/config.js";
import { gitRevParseHead, gitWorktreeAdd } from "../worktree/git.js";
import { appendFailedRun } from "../worktree/journal.js";
import { LockHeldError, claimLock } from "../worktree/lock.js";
import {
  computeRepoHash,
  lockPathForKey,
  runBranchName,
  runSlugFromId,
  runWorktreeDirName,
  runWorktreePathForDir,
  worktreeKeyForBrief,
} from "../worktree/paths.js";
import { pruneWorktrees } from "../worktree/prune.js";
import { resolveFactoryByName } from "./resolve.js";

export interface RunBriefAutomatedArgs {
  brief: Brief;
  cwd: string;
  store?: RunStore;
  buildRegistry?: () => ExecutorRegistry;
  abortSignal?: AbortSignal;
}

export interface RunBriefAutomatedResult {
  status: "succeeded" | "failed";
  runId: string;
  reason?: string;
  worktreePath?: string;
}

function defaultRegistry(): ExecutorRegistry {
  const reg = new ExecutorRegistry();
  reg.register(new ClaudeExecutor());
  return reg;
}

/**
 * Run one brief end-to-end the same way `minifac run` does: resolve the
 * brief's factory, claim the per-change lockfile, create the worktree,
 * invoke the runner, finalize. Returns a structured result rather than
 * printing to stderr — caller (autorun) is responsible for emitting log
 * events.
 *
 * Errors during setup (factory resolution, lock contention, worktree
 * creation) surface as `{ status: "failed", reason: <category> }`. Errors
 * from the runner itself surface with that runner's `reason`.
 */
export async function runBriefAutomated(
  args: RunBriefAutomatedArgs,
): Promise<RunBriefAutomatedResult> {
  const { brief, cwd, store, abortSignal } = args;
  const runId = randomUUID();
  const briefMode_inPlace = (brief.frontmatter as { mode?: string }).mode === "in-place";

  let factoryPath: string;
  try {
    factoryPath = await resolveFactoryByName(brief.frontmatter.factory, cwd);
  } catch (err) {
    return { status: "failed", runId, reason: `factory resolution: ${(err as Error).message}` };
  }

  let loaded: LoadedFactory;
  try {
    loaded = await loadFactory(factoryPath, cwd);
  } catch (err) {
    return { status: "failed", runId, reason: `factory load: ${(err as Error).message}` };
  }
  const factoryName = loaded.factory.name;

  const config = await loadWorktreeConfig(cwd);
  const repoHash = await computeRepoHash(cwd);
  const slug = runSlugFromId(runId);
  const change = brief.frontmatter.change;
  const branchName = runBranchName(change, slug);
  const worktreeDirName = runWorktreeDirName(change, slug);
  const key = worktreeKeyForBrief(repoHash, change);

  if (!briefMode_inPlace) {
    try {
      await pruneWorktrees({ config, callerRepoCwd: cwd, options: { lazy: true } });
    } catch {
      // best effort
    }
  }

  const lockPath = lockPathForKey(config, key);
  let lock: Awaited<ReturnType<typeof claimLock>> | undefined;
  try {
    lock = await claimLock(lockPath);
  } catch (err) {
    if (err instanceof LockHeldError) {
      return {
        status: "failed",
        runId,
        reason: `lockfile held for key \`${key}\` (PID ${err.holdingPid})`,
      };
    }
    return { status: "failed", runId, reason: `lock claim: ${(err as Error).message}` };
  }

  let runCwd: string;
  if (briefMode_inPlace) {
    runCwd = cwd;
  } else {
    const wtPath = runWorktreePathForDir(config, worktreeDirName);
    let baseRev: string;
    if (brief.frontmatter.base_branch && brief.frontmatter.base_branch.length > 0) {
      baseRev = brief.frontmatter.base_branch;
    } else {
      try {
        baseRev = await gitRevParseHead(cwd);
      } catch (err) {
        await lock.release().catch(() => undefined);
        return { status: "failed", runId, reason: `git rev-parse: ${(err as Error).message}` };
      }
    }
    try {
      await mkdir(config.worktreesDir, { recursive: true });
      await gitWorktreeAdd(cwd, wtPath, branchName, baseRev);
    } catch (err) {
      await lock.release().catch(() => undefined);
      return { status: "failed", runId, reason: `worktree create: ${(err as Error).message}` };
    }
    runCwd = wtPath;
  }

  const registry = (args.buildRegistry ?? defaultRegistry)();
  try {
    const result = await runFactory(loaded, {
      registry,
      brief,
      runCwd,
      ...(store ? { store } : {}),
      runId,
      ...(briefMode_inPlace ? {} : { branchName }),
      ...(abortSignal ? { abortSignal } : {}),
      onEvent: () => undefined,
    });
    if (result.status === "failed") {
      try {
        await appendFailedRun({
          worktreeDir: runCwd,
          status: "failed",
          endedAt: new Date().toISOString(),
          reason: result.reason,
        });
      } catch {
        // journal errors are non-fatal
      }
    }
    return {
      status: result.status === "succeeded" ? "succeeded" : "failed",
      runId,
      ...(result.reason ? { reason: result.reason } : {}),
      worktreePath: runCwd,
    };
  } finally {
    try {
      await lock.release();
    } catch {
      // best effort
    }
  }
}
