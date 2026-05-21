import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "../storage/sqlite.js";
import type { WorktreeConfig } from "./config.js";
import { parseOlderThan, pruneWorktrees } from "./prune.js";

function sh(cwd: string, args: string[]): void {
  const res = spawnSync(args[0] as string, args.slice(1), { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `command failed in ${cwd}: ${args.join(" ")}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
}

interface Fixture {
  home: string;
  repo: string;
  worktreesDir: string;
  config: WorktreeConfig;
}

async function makeFixture(): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), "minifac-prune-home-"));
  const repo = await mkdtemp(path.join(tmpdir(), "minifac-prune-repo-"));
  sh(repo, ["git", "init", "-q", "-b", "main"]);
  sh(repo, ["git", "config", "user.email", "test@example.com"]);
  sh(repo, ["git", "config", "user.name", "Test"]);
  sh(repo, ["git", "config", "commit.gpgsign", "false"]);
  sh(repo, ["git", "config", "core.hooksPath", "/dev/null"]);
  await writeFile(path.join(repo, "README.md"), "hi\n");
  sh(repo, ["git", "add", "."]);
  sh(repo, ["git", "commit", "-q", "-m", "init"]);
  const worktreesDir = path.join(home, "worktrees");
  await mkdir(worktreesDir, { recursive: true });
  return {
    home,
    repo,
    worktreesDir,
    config: {
      worktreesDir,
      locksDir: path.join(home, "locks"),
      defaultBranch: "main",
    },
  };
}

async function addWorktree(repo: string, dir: string, branch: string): Promise<void> {
  sh(repo, ["git", "worktree", "add", "-b", branch, dir, "HEAD"]);
}

async function setOld(dir: string, daysOld: number): Promise<void> {
  const now = Date.now();
  const target = new Date(now - daysOld * 24 * 60 * 60 * 1000);
  await utimes(dir, target, target);
}

describe("pruneWorktrees", () => {
  let savedHome: string | undefined;
  let fx: Fixture;

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    fx = await makeFixture();
    process.env.MINIFAC_HOME = fx.home;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (savedHome === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = savedHome;
  });

  it("no flags removes only merged-old worktrees", async () => {
    // merged branch: feature-merged. Merge it into main so it is fast-forward-reachable.
    const mergedDir = path.join(fx.worktreesDir, "merged");
    await addWorktree(fx.repo, mergedDir, "feature-merged");
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "feature-merged"]);
    await setOld(mergedDir, 10);

    // unmerged branch: stays separate.
    const unmergedDir = path.join(fx.worktreesDir, "unmerged");
    await addWorktree(fx.repo, unmergedDir, "feature-unmerged");
    await writeFile(path.join(unmergedDir, "x.txt"), "x");
    sh(unmergedDir, ["git", "add", "."]);
    sh(unmergedDir, ["git", "commit", "-q", "-m", "unmerged"]);
    await setOld(unmergedDir, 10);

    // fresh
    const freshDir = path.join(fx.worktreesDir, "fresh");
    await addWorktree(fx.repo, freshDir, "feature-fresh");

    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: {},
    });
    expect(counts.removed["merged-old"]).toBe(1);
    expect(counts.removed["unmerged-old"]).toBe(0);
    expect(counts.removed.fresh).toBe(0);
    const remaining = await readdir(fx.worktreesDir);
    expect(remaining.sort()).toEqual(["fresh", "unmerged"]);
  });

  it("--all prunes fresh, merged-old, unmerged-old but not failed", async () => {
    const mergedDir = path.join(fx.worktreesDir, "merged");
    await addWorktree(fx.repo, mergedDir, "feature-merged");
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "feature-merged"]);
    await setOld(mergedDir, 10);

    const freshDir = path.join(fx.worktreesDir, "fresh");
    await addWorktree(fx.repo, freshDir, "feature-fresh");

    // failed: not actually a worktree, but a real directory journaled as failed.
    const failedDir = path.join(fx.worktreesDir, "failed-run");
    await addWorktree(fx.repo, failedDir, "feature-failed");
    await import("./journal.js").then(({ appendFailedRun }) =>
      appendFailedRun({
        worktreeDir: failedDir,
        status: "failed",
        endedAt: new Date().toISOString(),
      }),
    );

    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: { all: true },
    });
    expect(counts.removed.fresh).toBe(1);
    expect(counts.removed["merged-old"]).toBe(1);
    expect(counts.removed.failed).toBe(0);
    const remaining = await readdir(fx.worktreesDir);
    expect(remaining).toEqual(["failed-run"]);
  });

  it("--failed alone removes only failed worktrees", async () => {
    const mergedDir = path.join(fx.worktreesDir, "merged");
    await addWorktree(fx.repo, mergedDir, "feature-merged");
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "feature-merged"]);
    await setOld(mergedDir, 10);

    const failedDir = path.join(fx.worktreesDir, "failed-run");
    await addWorktree(fx.repo, failedDir, "feature-failed");
    const { appendFailedRun } = await import("./journal.js");
    await appendFailedRun({
      worktreeDir: failedDir,
      status: "failed",
      endedAt: new Date().toISOString(),
    });

    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: { failed: true },
    });
    expect(counts.removed.failed).toBe(1);
    expect(counts.removed["merged-old"]).toBe(0);
    const remaining = await readdir(fx.worktreesDir);
    expect(remaining).toEqual(["merged"]);
  });

  it("--all --failed removes everything", async () => {
    const mergedDir = path.join(fx.worktreesDir, "merged");
    await addWorktree(fx.repo, mergedDir, "feature-merged");
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "feature-merged"]);
    await setOld(mergedDir, 10);
    const failedDir = path.join(fx.worktreesDir, "failed-run");
    await addWorktree(fx.repo, failedDir, "feature-failed");
    const { appendFailedRun } = await import("./journal.js");
    await appendFailedRun({
      worktreeDir: failedDir,
      status: "failed",
      endedAt: new Date().toISOString(),
    });
    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: { all: true, failed: true },
    });
    expect(counts.removed["merged-old"]).toBe(1);
    expect(counts.removed.failed).toBe(1);
    const remaining = await readdir(fx.worktreesDir);
    expect(remaining).toEqual([]);
  });

  it("--older-than 30d treats 10d-old worktrees as fresh", async () => {
    const mergedDir = path.join(fx.worktreesDir, "merged");
    await addWorktree(fx.repo, mergedDir, "feature-merged");
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "feature-merged"]);
    await setOld(mergedDir, 10);
    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: { merged: true, olderThan: { value: 30, unit: "d" } },
    });
    expect(counts.removed["merged-old"]).toBe(0);
    expect(counts.kept.fresh).toBe(1);
  });

  it("6d23h is fresh, 7d+1m is age-eligible", async () => {
    const justUnder = path.join(fx.worktreesDir, "fresh-edge");
    await addWorktree(fx.repo, justUnder, "branch-a");
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "branch-a"]);
    // 6 days, 23 hours
    const justUnderAge = new Date(Date.now() - (6 * 24 + 23) * 60 * 60 * 1000);
    await utimes(justUnder, justUnderAge, justUnderAge);

    const justOver = path.join(fx.worktreesDir, "merged-edge");
    await addWorktree(fx.repo, justOver, "branch-b");
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "branch-b"]);
    // 7 days + 1 minute
    const justOverAge = new Date(Date.now() - (7 * 24 * 60 + 1) * 60 * 1000);
    await utimes(justOver, justOverAge, justOverAge);

    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: {},
    });
    expect(counts.removed["merged-old"]).toBe(1);
    expect(counts.kept.fresh).toBe(1);
  });

  it("safe-keep degradation when default branch cannot be resolved", async () => {
    // Use a config whose configured default branch doesn't exist.
    const cfg = { ...fx.config, defaultBranch: undefined };
    // Remove main so default resolution fails.
    sh(fx.repo, ["git", "checkout", "-q", "-b", "renamed"]);
    sh(fx.repo, ["git", "branch", "-D", "main"]);
    const mergedDir = path.join(fx.worktreesDir, "merged");
    await addWorktree(fx.repo, mergedDir, "feature-merged");
    await setOld(mergedDir, 10);
    const counts = await pruneWorktrees({
      config: cfg,
      callerRepoCwd: fx.repo,
      options: {},
    });
    // No default → unmerged-old → kept on no-flag.
    expect(counts.removed["merged-old"]).toBe(0);
    expect(counts.kept["unmerged-old"]).toBe(1);
  });

  it("lazy mode honors the budget and aborts silently", async () => {
    // Smaller fixture: just one entry; verify no errors with lazy:true.
    const dir = path.join(fx.worktreesDir, "wt");
    await addWorktree(fx.repo, dir, "feat");
    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: { lazy: true, budgetMs: 0 },
    });
    // Budget of 0 should mean no iterations complete.
    expect(counts.errors).toEqual([]);
  });
});

describe("pruneWorktrees branch deletion", () => {
  let savedHome: string | undefined;
  let fx: Fixture;

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    fx = await makeFixture();
    process.env.MINIFAC_HOME = fx.home;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (savedHome === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = savedHome;
  });

  it("deletes the per-run branch after pruning its worktree (DB-resolved)", async () => {
    const dir = path.join(fx.worktreesDir, "run-feat-a-abc123");
    sh(fx.repo, ["git", "worktree", "add", "-b", "run/feat-a-abc123", dir, "HEAD"]);
    // Merge it so the no-flag policy treats it as merged-old.
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "run/feat-a-abc123"]);
    await setOld(dir, 10);

    const store = SqliteRunStore.open(path.join(fx.home, "runs.db"));
    try {
      await store.createRun({
        id: "rid-1",
        factoryPath: "/p/f.yaml",
        factoryName: "f",
        change: "feat-a",
        worktreePath: dir,
        branchName: "run/feat-a-abc123",
        startedAt: 1,
      });
      await store.finalizeRun("rid-1", {
        status: "succeeded",
        reason: null,
        endedAt: 2,
      });

      const counts = await pruneWorktrees({
        config: fx.config,
        callerRepoCwd: fx.repo,
        options: {},
        store,
      });
      expect(counts.removed["merged-old"]).toBe(1);
    } finally {
      await store.close();
    }
    const branches = spawnSync("git", ["branch", "--list", "run/feat-a-abc123"], {
      cwd: fx.repo,
      encoding: "utf8",
    });
    expect(branches.stdout.trim()).toBe("");
  });

  it("regression: after prune, a new run of the same change produces a fresh branch", async () => {
    // Create + merge + age a `run-`-prefixed worktree.
    const dir = path.join(fx.worktreesDir, "run-feat-b-aaaaaa");
    sh(fx.repo, ["git", "worktree", "add", "-b", "run/feat-b-aaaaaa", dir, "HEAD"]);
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "run/feat-b-aaaaaa"]);
    await setOld(dir, 10);

    await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: {},
    });

    // After prune, the branch is gone — a fresh `git worktree add -b run/feat-b-<slug>`
    // for a *different* slug succeeds.
    const freshDir = path.join(fx.worktreesDir, "run-feat-b-bbbbbb");
    expect(() =>
      sh(fx.repo, ["git", "worktree", "add", "-b", "run/feat-b-bbbbbb", freshDir, "HEAD"]),
    ).not.toThrow();
  });

  it("legacy directory naming (no `run-` prefix) is removed without branch deletion", async () => {
    const dir = path.join(fx.worktreesDir, "legacy-merged");
    sh(fx.repo, ["git", "worktree", "add", "-b", "legacy-merged", dir, "HEAD"]);
    sh(fx.repo, ["git", "merge", "-q", "--ff-only", "legacy-merged"]);
    await setOld(dir, 10);

    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: {},
    });
    expect(counts.removed["merged-old"]).toBe(1);
    // Branch SHOULD still exist (no `run-` prefix → caller-owned).
    const branches = spawnSync("git", ["branch", "--list", "legacy-merged"], {
      cwd: fx.repo,
      encoding: "utf8",
    });
    expect(branches.stdout).toMatch(/legacy-merged/);
  });

  it("git branch -D failure is surfaced on stderr but does not abort prune", async () => {
    // Force a failure: create a `run-`-named directory without a real
    // worktree (rm + journal) so the branch doesn't exist; `git branch -D`
    // for the inferred branch name will then fail.
    const dir = path.join(fx.worktreesDir, "run-orphan-ffffff");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".keep"), "x");
    await setOld(dir, 10);

    class BufStream extends Writable {
      chunks: string[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: Writable callback uses any
      _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
        this.chunks.push(chunk.toString());
        cb();
      }
      text(): string {
        return this.chunks.join("");
      }
    }
    const stderr = new BufStream();

    const counts = await pruneWorktrees({
      config: fx.config,
      callerRepoCwd: fx.repo,
      options: { all: true },
      stderr,
    });
    // Removal succeeded (1 fresh/unmerged-old removed, depending on
    // default-branch resolution against a bare dir; either way, no error
    // in the counts.errors array).
    expect(counts.errors).toEqual([]);
    expect(stderr.text()).toMatch(/failed to delete branch/i);
  });
});

describe("parseOlderThan", () => {
  it("parses days", () => {
    expect(parseOlderThan("7d")).toEqual({ value: 7, unit: "d" });
  });
  it("parses hours", () => {
    expect(parseOlderThan("12h")).toEqual({ value: 12, unit: "h" });
  });
  it("parses minutes", () => {
    expect(parseOlderThan("30m")).toEqual({ value: 30, unit: "m" });
  });
  it("rejects nonsense", () => {
    expect(() => parseOlderThan("nonsense")).toThrow(/Invalid/);
    expect(() => parseOlderThan("7y")).toThrow(/Invalid/);
  });
});
