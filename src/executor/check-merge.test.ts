import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CheckMergeExecutor } from "./check-merge.js";
import type { NodeEvent, ResolvedNode, RunContext } from "./types.js";

interface Snapshot {
  head: string;
  porcelain: string;
  untracked: string;
  mergeFiles: Record<string, string | null>;
}

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) exited ${r.code}: ${r.stderr}`);
  }
  return r.stdout;
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-check-merge-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

async function commitFile(cwd: string, file: string, contents: string, msg: string): Promise<void> {
  await writeFile(path.join(cwd, file), contents, "utf8");
  await git(cwd, "add", file);
  await git(cwd, "commit", "-q", "-m", msg);
}

async function snapshot(cwd: string): Promise<Snapshot> {
  const head = (await git(cwd, "rev-parse", "HEAD")).trim();
  const porcelain = (await runGit(cwd, ["status", "--porcelain"])).stdout;
  const untracked = (await runGit(cwd, ["ls-files", "--others", "--exclude-standard"])).stdout;
  const mergeFiles: Record<string, string | null> = {};
  for (const name of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"]) {
    try {
      const buf = await readFile(path.join(cwd, ".git", name));
      mergeFiles[name] = buf.toString("hex");
    } catch {
      mergeFiles[name] = null;
    }
  }
  return { head, porcelain, untracked, mergeFiles };
}

function makeNode(withVal: unknown): ResolvedNode {
  return {
    id: "check",
    executor: "check-merge",
    terminal: true,
    with: withVal as Record<string, unknown>,
  };
}

function makeCtx(cwd: string): RunContext {
  return {
    factory: { name: "f", nodes: { check: { executor: "check-merge", terminal: true } }, edges: [] },
    priorResults: [],
    nodeId: "check",
    iteration: 1,
    cwd,
  };
}

async function collect(exec: CheckMergeExecutor, node: ResolvedNode, ctx: RunContext): Promise<NodeEvent[]> {
  const events: NodeEvent[] = [];
  for await (const e of exec.run(node, ctx)) events.push(e);
  return events;
}

function finalStatus(events: NodeEvent[]): { status: "succeeded" | "failed"; meta: unknown } {
  const last = events[events.length - 1];
  if (!last || last.kind !== "status") throw new Error("no terminal status event");
  if (last.status !== "succeeded" && last.status !== "failed") {
    throw new Error(`unexpected terminal status: ${last.status}`);
  }
  return { status: last.status, meta: last.meta };
}

describe("CheckMergeExecutor", () => {
  it("fast-forward case passes under any-merge", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      await git(repo, "checkout", "-q", "-b", "feature");
      await commitFile(repo, "a.txt", "1\n2\n", "advance");
      // Base = main, HEAD = feature, fast-forward possible.
      const exec = new CheckMergeExecutor();
      const before = await snapshot(repo);
      const events = await collect(exec, makeNode({ base: "main", mode: "any-merge" }), makeCtx(repo));
      expect(finalStatus(events).status).toBe("succeeded");
      const after = await snapshot(repo);
      expect(after).toEqual(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("fast-forward case passes under fast-forward", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      await git(repo, "checkout", "-q", "-b", "feature");
      await commitFile(repo, "a.txt", "1\n2\n", "advance");
      const exec = new CheckMergeExecutor();
      const before = await snapshot(repo);
      const events = await collect(
        exec,
        makeNode({ base: "main", mode: "fast-forward" }),
        makeCtx(repo),
      );
      expect(finalStatus(events).status).toBe("succeeded");
      const after = await snapshot(repo);
      expect(after).toEqual(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("divergent-but-clean merge passes under any-merge", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      await git(repo, "checkout", "-q", "-b", "feature");
      await commitFile(repo, "b.txt", "feature\n", "feature");
      await git(repo, "checkout", "-q", "main");
      await commitFile(repo, "c.txt", "main\n", "main change");
      await git(repo, "checkout", "-q", "feature");
      const exec = new CheckMergeExecutor();
      const before = await snapshot(repo);
      const events = await collect(exec, makeNode({ base: "main", mode: "any-merge" }), makeCtx(repo));
      expect(finalStatus(events).status).toBe("succeeded");
      const after = await snapshot(repo);
      expect(after).toEqual(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("divergent-but-clean merge fails under fast-forward with a clear message", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      await git(repo, "checkout", "-q", "-b", "feature");
      await commitFile(repo, "b.txt", "feature\n", "feature");
      await git(repo, "checkout", "-q", "main");
      await commitFile(repo, "c.txt", "main\n", "main change");
      await git(repo, "checkout", "-q", "feature");
      const exec = new CheckMergeExecutor();
      const before = await snapshot(repo);
      const events = await collect(
        exec,
        makeNode({ base: "main", mode: "fast-forward" }),
        makeCtx(repo),
      );
      const fs = finalStatus(events);
      expect(fs.status).toBe("failed");
      expect(String((fs.meta as { message: string }).message)).toMatch(
        /merge commit required under fast-forward mode/,
      );
      const after = await snapshot(repo);
      expect(after).toEqual(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("conflicting merge fails under any-merge", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      await git(repo, "checkout", "-q", "-b", "feature");
      await commitFile(repo, "a.txt", "feature line\n", "feature edit");
      await git(repo, "checkout", "-q", "main");
      await commitFile(repo, "a.txt", "main line\n", "main edit");
      await git(repo, "checkout", "-q", "feature");
      const exec = new CheckMergeExecutor();
      const before = await snapshot(repo);
      const events = await collect(exec, makeNode({ base: "main", mode: "any-merge" }), makeCtx(repo));
      const fs = finalStatus(events);
      expect(fs.status).toBe("failed");
      expect(String((fs.meta as { message: string }).message)).toMatch(/conflict/);
      const after = await snapshot(repo);
      expect(after).toEqual(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("conflicting merge fails under fast-forward", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      await git(repo, "checkout", "-q", "-b", "feature");
      await commitFile(repo, "a.txt", "feature line\n", "feature edit");
      await git(repo, "checkout", "-q", "main");
      await commitFile(repo, "a.txt", "main line\n", "main edit");
      await git(repo, "checkout", "-q", "feature");
      const exec = new CheckMergeExecutor();
      const before = await snapshot(repo);
      const events = await collect(
        exec,
        makeNode({ base: "main", mode: "fast-forward" }),
        makeCtx(repo),
      );
      expect(finalStatus(events).status).toBe("failed");
      const after = await snapshot(repo);
      expect(after).toEqual(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("missing-branch base fails with a message naming the bad base", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      const exec = new CheckMergeExecutor();
      const before = await snapshot(repo);
      const events = await collect(
        exec,
        makeNode({ base: "no-such-branch", mode: "any-merge" }),
        makeCtx(repo),
      );
      const fs = finalStatus(events);
      expect(fs.status).toBe("failed");
      expect(String((fs.meta as { message: string }).message)).toMatch(/no-such-branch/);
      const after = await snapshot(repo);
      expect(after).toEqual(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("empty base after substitution fails with the explicit-base message", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      const exec = new CheckMergeExecutor();
      const events = await collect(exec, makeNode({ base: "" }), makeCtx(repo));
      const fs = finalStatus(events);
      expect(fs.status).toBe("failed");
      expect(String((fs.meta as { message: string }).message)).toMatch(/declare `with: \{ base/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("unknown mode value is rejected", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      const exec = new CheckMergeExecutor();
      const events = await collect(
        exec,
        makeNode({ base: "main", mode: "rebase" }),
        makeCtx(repo),
      );
      const fs = finalStatus(events);
      expect(fs.status).toBe("failed");
      expect(String((fs.meta as { message: string }).message)).toMatch(/rebase/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("unknown `with:` key is rejected", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      const exec = new CheckMergeExecutor();
      const events = await collect(
        exec,
        makeNode({ base: "main", strategy: "ours" }),
        makeCtx(repo),
      );
      const fs = finalStatus(events);
      expect(fs.status).toBe("failed");
      expect(String((fs.meta as { message: string }).message)).toMatch(/strategy/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("missing mode defaults to any-merge (divergent merge passes)", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      await git(repo, "checkout", "-q", "-b", "feature");
      await commitFile(repo, "b.txt", "feature\n", "feature");
      await git(repo, "checkout", "-q", "main");
      await commitFile(repo, "c.txt", "main\n", "main change");
      await git(repo, "checkout", "-q", "feature");
      const exec = new CheckMergeExecutor();
      const events = await collect(exec, makeNode({ base: "main" }), makeCtx(repo));
      expect(finalStatus(events).status).toBe("succeeded");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("final event is always a status event with succeeded or failed", async () => {
    const repo = await makeRepo();
    try {
      await commitFile(repo, "a.txt", "1\n", "init");
      const exec = new CheckMergeExecutor();
      const events = await collect(exec, makeNode({ base: "main" }), makeCtx(repo));
      const last = events[events.length - 1];
      expect(last?.kind).toBe("status");
      if (last && last.kind === "status") {
        expect(["succeeded", "failed"]).toContain(last.status);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
