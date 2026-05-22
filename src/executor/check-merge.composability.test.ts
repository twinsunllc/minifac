import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Factory } from "../factory/schema.js";
import { runFactory } from "../runner/run.js";
import { CheckMergeExecutor } from "./check-merge.js";
import { ExecutorRegistry } from "./registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode, RunContext } from "./types.js";

function git(cwd: string, ...args: string[]): Promise<string> {
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
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`));
    });
  });
}

async function makeRepoConflicting(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-cm-compose-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "a.txt"), "1\n");
  await git(dir, "add", "a.txt");
  await git(dir, "commit", "-q", "-m", "init");
  await git(dir, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(dir, "a.txt"), "feature\n");
  await git(dir, "add", "a.txt");
  await git(dir, "commit", "-q", "-m", "feature edit");
  await git(dir, "checkout", "-q", "main");
  await writeFile(path.join(dir, "a.txt"), "main\n");
  await git(dir, "add", "a.txt");
  await git(dir, "commit", "-q", "-m", "main edit");
  await git(dir, "checkout", "-q", "feature");
  return dir;
}

class TrackingExecutor implements NodeExecutor {
  readonly type: string;
  readonly supportsMcp = false;
  visited: string[] = [];

  constructor(type: string) {
    this.type = type;
  }

  async *run(node: ResolvedNode, _ctx: RunContext): AsyncIterable<NodeEvent> {
    this.visited.push(node.id);
    yield { kind: "status", status: "succeeded" };
  }
}

describe("check-merge composability", () => {
  it("on_failure edge routes to a downstream cleanup node when the probe conflicts", async () => {
    const repo = await makeRepoConflicting();
    try {
      const factory: Factory = {
        name: "compose",
        brief: "none",
        nodes: {
          probe: {
            executor: "check-merge",
            terminal: false,
            cwd: repo,
            with: { base: "main", mode: "any-merge" },
          },
          cleanup: {
            executor: "tracking",
            terminal: true,
            cwd: repo,
          },
        },
        edges: [{ from: "probe", to: "cleanup", when: "on_failure" }],
      };

      const registry = new ExecutorRegistry();
      registry.register(new CheckMergeExecutor());
      const tracker = new TrackingExecutor("tracking");
      registry.register(tracker);

      const result = await runFactory(
        {
          factory,
          sourcePath: path.join(repo, "factory.yaml"),
          sourceDir: repo,
        },
        { registry },
      );

      expect(result.status).toBe("succeeded");
      expect(tracker.visited).toEqual(["cleanup"]);
      // The probe node should have failed, then the on_failure edge ran cleanup.
      const probeEntry = result.log.find((e) => e.nodeId === "probe");
      expect(probeEntry?.status).toBe("failed");
      const cleanupEntry = result.log.find((e) => e.nodeId === "cleanup");
      expect(cleanupEntry?.status).toBe("succeeded");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
