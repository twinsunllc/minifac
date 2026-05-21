import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WorktreeConfig } from "./config.js";
import {
  computeRepoHash,
  lockPathForKey,
  runBranchName,
  runSlugFromId,
  runWorktreeDirName,
  runWorktreePathForDir,
  worktreeKeyForBrief,
  worktreeKeyForFactory,
  worktreePathForKey,
} from "./paths.js";

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "minifac-paths-"));
}

describe("paths", () => {
  it("computeRepoHash is stable for the same repo root", async () => {
    const dir = await makeDir();
    const a = await computeRepoHash(dir);
    const b = await computeRepoHash(dir);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("computeRepoHash differs across distinct repo roots", async () => {
    const dirA = await makeDir();
    const dirB = await makeDir();
    const a = await computeRepoHash(dirA);
    const b = await computeRepoHash(dirB);
    expect(a).not.toBe(b);
  });

  it("worktreeKeyForBrief shape", () => {
    expect(worktreeKeyForBrief("abcd1234", "factory-inputs-core")).toBe(
      "abcd1234-factory-inputs-core",
    );
  });

  it("worktreeKeyForFactory uses base-36 timestamp and is ≤ 8 chars suffix for current epoch", () => {
    const now = Date.now();
    const key = worktreeKeyForFactory("abcd1234", "hello", now);
    const parts = key.split("-");
    expect(parts[0]).toBe("abcd1234");
    expect(parts[1]).toBe("hello");
    const ts = parts[2] ?? "";
    expect(ts.length).toBeLessThanOrEqual(8);
    // base-36 alphabet
    expect(ts).toMatch(/^[0-9a-z]+$/);
  });

  it("worktreeKeyForFactory base-36 of 123456789 has expected value", () => {
    expect(worktreeKeyForFactory("abcd1234", "hello", 123456789)).toBe(
      `abcd1234-hello-${(123456789).toString(36)}`,
    );
  });

  it("worktreePathForKey + lockPathForKey compose the config paths", () => {
    const cfg: WorktreeConfig = {
      worktreesDir: "/wt",
      locksDir: "/locks",
    };
    expect(worktreePathForKey(cfg, "abc-foo")).toBe(path.join("/wt", "abc-foo"));
    expect(lockPathForKey(cfg, "abc-foo")).toBe(path.join("/locks", "abc-foo.lock"));
  });

  it("runSlugFromId is the first 6 chars lowercased", () => {
    expect(runSlugFromId("ABCDEF1234567890")).toBe("abcdef");
    expect(runSlugFromId("a1b2c3d4")).toBe("a1b2c3");
    // UUIDs are already lowercase but the contract still lowercases:
    expect(runSlugFromId("F0F0F0F0-1111-2222-3333-444444444444")).toBe("f0f0f0");
  });

  it("runBranchName shape is `run/<segment>-<slug>`", () => {
    expect(runBranchName("my-change", "abcdef")).toBe("run/my-change-abcdef");
    // Works the same when the segment is a factory name (brief-less callers).
    expect(runBranchName("hello", "012345")).toBe("run/hello-012345");
  });

  it("runWorktreeDirName shape is `run-<segment>-<slug>`", () => {
    expect(runWorktreeDirName("my-change", "abcdef")).toBe("run-my-change-abcdef");
    expect(runWorktreeDirName("hello", "012345")).toBe("run-hello-012345");
  });

  it("runWorktreePathForDir joins the dir name under config.worktreesDir", () => {
    const cfg: WorktreeConfig = {
      worktreesDir: "/wt",
      locksDir: "/locks",
    };
    expect(runWorktreePathForDir(cfg, "run-my-change-abcdef")).toBe(
      path.join("/wt", "run-my-change-abcdef"),
    );
  });
});
