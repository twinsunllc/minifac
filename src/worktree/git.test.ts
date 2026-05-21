import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GitError,
  gitBranchDelete,
  gitBranchMerged,
  gitDefaultBranch,
  gitRemoteOriginUrl,
  gitRevParseHead,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRemoveForce,
} from "./git.js";

function sh(cwd: string, args: string[]): void {
  const res = spawnSync(args[0] as string, args.slice(1), { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `command failed in ${cwd}: ${args.join(" ")}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-git-"));
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "config", "user.email", "test@example.com"]);
  sh(dir, ["git", "config", "user.name", "Test"]);
  sh(dir, ["git", "config", "commit.gpgsign", "false"]);
  // Isolate from any user-level prepare-commit-msg hook (which can prepend
  // the branch name to subjects and skew the squash-merge heuristic test).
  sh(dir, ["git", "config", "core.hooksPath", "/dev/null"]);
  await writeFile(path.join(dir, "README.md"), "hi\n");
  sh(dir, ["git", "add", "."]);
  sh(dir, ["git", "commit", "-q", "-m", "init"]);
  return dir;
}

describe("git wrappers", () => {
  it("gitRemoteOriginUrl returns empty when not configured", async () => {
    const repo = await makeRepo();
    expect(await gitRemoteOriginUrl(repo)).toBe("");
  });

  it("gitRemoteOriginUrl returns the configured value", async () => {
    const repo = await makeRepo();
    sh(repo, ["git", "config", "--add", "remote.origin.url", "git@github.com:foo/bar.git"]);
    expect(await gitRemoteOriginUrl(repo)).toBe("git@github.com:foo/bar.git");
  });

  it("gitRevParseHead returns a sha", async () => {
    const repo = await makeRepo();
    const sha = await gitRevParseHead(repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("gitWorktreeAdd succeeds for a new branch", async () => {
    const repo = await makeRepo();
    const wt = await mkdtemp(path.join(tmpdir(), "minifac-wt-"));
    const target = path.join(wt, "tree");
    const head = await gitRevParseHead(repo);
    await gitWorktreeAdd(repo, target, "feature-x", head);
    // Worktree branch should exist.
    const res = spawnSync("git", ["branch", "--list", "feature-x"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(res.stdout).toMatch(/feature-x/);
    // Cleanup.
    await gitWorktreeRemoveForce(repo, target);
  });

  it("gitWorktreeAdd throws GitError when branch already exists", async () => {
    const repo = await makeRepo();
    sh(repo, ["git", "branch", "dup"]);
    const wt = await mkdtemp(path.join(tmpdir(), "minifac-wt-"));
    const target = path.join(wt, "tree");
    const head = await gitRevParseHead(repo);
    await expect(gitWorktreeAdd(repo, target, "dup", head)).rejects.toBeInstanceOf(GitError);
  });

  it("gitDefaultBranch honors configured override", async () => {
    const repo = await makeRepo();
    expect(await gitDefaultBranch(repo, "trunk")).toBe("trunk");
  });

  it("gitDefaultBranch falls back to main when present", async () => {
    const repo = await makeRepo();
    expect(await gitDefaultBranch(repo)).toBe("main");
  });

  it("gitBranchMerged returns true after a fast-forward merge", async () => {
    const repo = await makeRepo();
    sh(repo, ["git", "checkout", "-q", "-b", "feature"]);
    await writeFile(path.join(repo, "f.txt"), "f\n");
    sh(repo, ["git", "add", "."]);
    sh(repo, ["git", "commit", "-q", "-m", "feature work"]);
    sh(repo, ["git", "checkout", "-q", "main"]);
    sh(repo, ["git", "merge", "-q", "--ff-only", "feature"]);
    expect(await gitBranchMerged(repo, "feature", "main")).toBe(true);
  });

  it("gitBranchMerged returns false on an unmerged branch", async () => {
    const repo = await makeRepo();
    sh(repo, ["git", "checkout", "-q", "-b", "feature"]);
    await writeFile(path.join(repo, "f.txt"), "f\n");
    sh(repo, ["git", "add", "."]);
    sh(repo, ["git", "commit", "-q", "-m", "feature work"]);
    sh(repo, ["git", "checkout", "-q", "main"]);
    expect(await gitBranchMerged(repo, "feature", "main")).toBe(false);
  });

  it("gitBranchMerged subject heuristic detects squash merges", async () => {
    const repo = await makeRepo();
    sh(repo, ["git", "checkout", "-q", "-b", "feature"]);
    await writeFile(path.join(repo, "f.txt"), "f\n");
    sh(repo, ["git", "add", "."]);
    sh(repo, ["git", "commit", "-q", "-m", "Add f.txt for feature"]);
    sh(repo, ["git", "checkout", "-q", "main"]);
    // Simulate squash merge: a new main commit with the same subject as
    // feature's tip, but no commit hashes in common.
    await writeFile(path.join(repo, "g.txt"), "g\n");
    sh(repo, ["git", "add", "."]);
    sh(repo, ["git", "commit", "-q", "-m", "Add f.txt for feature"]);
    expect(await gitBranchMerged(repo, "feature", "main")).toBe(true);
  });

  it("gitWorktreePrune runs without error", async () => {
    const repo = await makeRepo();
    await gitWorktreePrune(repo);
  });

  it("gitBranchDelete removes an existing local branch", async () => {
    const repo = await makeRepo();
    sh(repo, ["git", "branch", "to-delete"]);
    const before = spawnSync("git", ["branch", "--list", "to-delete"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(before.stdout).toMatch(/to-delete/);
    await gitBranchDelete(repo, "to-delete");
    const after = spawnSync("git", ["branch", "--list", "to-delete"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(after.stdout.trim()).toBe("");
  });

  it("gitBranchDelete throws GitError when the branch does not exist", async () => {
    const repo = await makeRepo();
    await expect(gitBranchDelete(repo, "no-such-branch")).rejects.toBeInstanceOf(GitError);
  });
});
