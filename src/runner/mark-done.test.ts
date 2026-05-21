import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markBriefDone } from "./mark-done.js";

function sh(cwd: string, args: string[]): { status: number | null; stderr: string } {
  const res = spawnSync(args[0] as string, args.slice(1), { cwd, encoding: "utf8" });
  return { status: res.status, stderr: res.stderr };
}

function shOrThrow(cwd: string, args: string[]): void {
  const res = spawnSync(args[0] as string, args.slice(1), { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${res.stderr}`);
  }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-mark-done-"));
  shOrThrow(dir, ["git", "init", "-q", "-b", "main"]);
  shOrThrow(dir, ["git", "config", "user.email", "test@example.com"]);
  shOrThrow(dir, ["git", "config", "user.name", "Test"]);
  shOrThrow(dir, ["git", "config", "commit.gpgsign", "false"]);
  shOrThrow(dir, ["git", "config", "core.hooksPath", "/dev/null"]);
  await writeFile(path.join(dir, "README.md"), "hi\n");
  shOrThrow(dir, ["git", "add", "."]);
  shOrThrow(dir, ["git", "commit", "-q", "-m", "init"]);
  return dir;
}

async function writeBrief(repo: string, rel: string): Promise<string> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, "---\nchange: foo\nfactory: sdd\n---\nbody\n", "utf8");
  return full;
}

describe("markBriefDone", () => {
  it("moves the brief and creates a commit", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "inputs/foo.md");
    shOrThrow(repo, ["git", "add", "."]);
    shOrThrow(repo, ["git", "commit", "-q", "-m", "add brief"]);

    const result = await markBriefDone({ change: "foo", runCwd: repo });
    expect(result.moved).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(existsSync(path.join(repo, "inputs", "foo.md"))).toBe(false);
    expect(existsSync(path.join(repo, "inputs", "done", "foo.md"))).toBe(true);
    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(log.stdout.trim()).toBe("Mark foo done");
  });

  it("idempotent skip when source missing and dest exists", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "inputs/done/foo.md");
    shOrThrow(repo, ["git", "add", "."]);
    shOrThrow(repo, ["git", "commit", "-q", "-m", "add done brief"]);

    const result = await markBriefDone({ change: "foo", runCwd: repo });
    expect(result.moved).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("logs a warning when git mv fails (no source, no dest)", async () => {
    const repo = await makeRepo();
    const result = await markBriefDone({ change: "missing", runCwd: repo });
    expect(result.moved).toBe(false);
    expect(result.warning).toMatch(/missing/);
  });

  it("logs a warning when git mv fails for an untracked file", async () => {
    const repo = await makeRepo();
    // Write the file but never `git add` it — `git mv` refuses untracked.
    await writeBrief(repo, "inputs/foo.md");
    const result = await markBriefDone({ change: "foo", runCwd: repo });
    expect(result.moved).toBe(false);
    expect(result.warning).toMatch(/git mv/);
  });
});
