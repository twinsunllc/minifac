import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { ExecutorRegistry } from "./executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode } from "./executor/types.js";

class BufferStream extends Writable {
  chunks: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: Writable callback shape uses any internally
  _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

async function makeFixtureDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "minifac-cli-"));
}

async function writeFixture(dir: string, rel: string, contents: string): Promise<string> {
  const filePath = path.join(dir, rel);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

function sh(cwd: string, args: string[]): void {
  const res = spawnSync(args[0] as string, args.slice(1), { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      `command failed in ${cwd}: ${args.join(" ")}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
}

async function makeGitRepoFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-cli-repo-"));
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "config", "user.email", "test@example.com"]);
  sh(dir, ["git", "config", "user.name", "Test"]);
  sh(dir, ["git", "config", "commit.gpgsign", "false"]);
  sh(dir, ["git", "config", "core.hooksPath", "/dev/null"]);
  await writeFile(path.join(dir, "README.md"), "hi\n");
  sh(dir, ["git", "add", "."]);
  sh(dir, ["git", "commit", "-q", "-m", "init"]);
  return dir;
}

function fakeRegistry(scripts: Record<string, NodeEvent[]>): () => ExecutorRegistry {
  return () => {
    const reg = new ExecutorRegistry();
    const exec: NodeExecutor = {
      type: "test",
      async *run(node: ResolvedNode): AsyncIterable<NodeEvent> {
        const ev = scripts[node.id] ?? [{ kind: "status", status: "succeeded" }];
        for (const e of ev) yield e;
      },
    };
    reg.register(exec);
    return reg;
  };
}

const NONE_FACTORY = `name: hello
brief: none
nodes:
  a:
    executor: test
    terminal: true
edges: []
`;

const REQUIRED_FACTORY = `name: sdd
brief: required
nodes:
  a:
    executor: test
    terminal: true
edges: []
`;

const OPTIONAL_FACTORY = `name: maybe
brief: optional
nodes:
  a:
    executor: test
    terminal: true
edges: []
`;

describe("runCli", () => {
  let savedHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    home = await mkdtemp(path.join(tmpdir(), "minifac-home-"));
    process.env.MINIFAC_HOME = home;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (savedHome === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = savedHome;
  });

  it("--help exits 0", async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["--help"], { stdout: out, stderr: err });
    expect(code).toBe(0);
  });

  it("--version exits 0", async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["--version"], { stdout: out, stderr: err });
    expect(code).toBe(0);
  });

  it("missing resolution exits 1 with stderr message", async () => {
    const dir = await makeFixtureDir();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", "no-such-thing"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/Could not resolve/i);
  });

  it("factory-by-name (brief: none) runs end-to-end under --in-place", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", "hello"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({
        a: [
          { kind: "stdout", line: "hi" },
          { kind: "status", status: "succeeded" },
        ],
      }),
    });
    expect(code).toBe(0);
    expect(out.text()).toContain("[a] hi");
    expect(err.text()).toMatch(/\[status\] a iter=1: succeeded/);
    expect(err.text()).toMatch(/\[run\] succeeded cwd=/);
  });

  it("brief-by-name runs end-to-end and substitutes tokens", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(
      dir,
      "examples/sdd.yaml",
      `name: sdd
brief: required
nodes:
  a:
    executor: test
    terminal: true
    with:
      prompt: "Work on {{ brief.change }}."
edges: []
`,
    );
    await writeFixture(
      dir,
      "inputs/my-change.md",
      `---
change: my-change
factory: sdd
mode: in-place
---
the body
`,
    );
    const captured: string[] = [];
    const buildRegistry = (): ExecutorRegistry => {
      const reg = new ExecutorRegistry();
      const exec: NodeExecutor = {
        type: "test",
        async *run(node: ResolvedNode): AsyncIterable<NodeEvent> {
          captured.push(typeof node.with?.prompt === "string" ? node.with.prompt : "");
          yield { kind: "status", status: "succeeded" };
        },
      };
      reg.register(exec);
      return reg;
    };
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "my-change"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry,
    });
    expect(code).toBe(0);
    expect(captured[0]).toBe("Work on my-change.");
  });

  it("brief-by-path runs end-to-end (in-place)", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/sdd.yaml", REQUIRED_FACTORY);
    const briefPath = await writeFixture(
      dir,
      "inputs/foo.md",
      `---
change: foo
factory: sdd
---
body
`,
    );
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", briefPath], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "succeeded" }] }),
    });
    expect(code).toBe(0);
  });

  it("brief takes precedence over a same-named factory", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/sdd.yaml", REQUIRED_FACTORY);
    await writeFixture(
      dir,
      "inputs/sdd.md",
      `---
change: sdd-via-brief
factory: sdd
mode: in-place
---
`,
    );
    let sawBrief = false;
    const buildRegistry = (): ExecutorRegistry => {
      const reg = new ExecutorRegistry();
      const exec: NodeExecutor = {
        type: "test",
        async *run(_node: ResolvedNode): AsyncIterable<NodeEvent> {
          sawBrief = true;
          yield { kind: "status", status: "succeeded" };
        },
      };
      reg.register(exec);
      return reg;
    };
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "sdd"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry,
    });
    expect(code).toBe(0);
    expect(sawBrief).toBe(true);
    expect(err.text()).not.toMatch(/requires a brief/);
  });

  it("brief: required factory invoked brief-less is rejected (exit 1)", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/sdd.yaml", REQUIRED_FACTORY);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", "sdd"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({}),
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/requires a brief/);
  });

  it("brief: none factory invoked with a brief is rejected (exit 1)", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    await writeFixture(
      dir,
      "inputs/hello-brief.md",
      `---
change: hello-brief
factory: hello
mode: in-place
---
`,
    );
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "hello-brief"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({}),
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/brief: none|does not accept|declares `brief: none`/i);
  });

  it("brief: optional factory accepts either invocation mode", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/maybe.yaml", OPTIONAL_FACTORY);
    const out1 = new BufferStream();
    const err1 = new BufferStream();
    const code1 = await runCli(["run", "--in-place", "maybe"], {
      stdout: out1,
      stderr: err1,
      runCwd: dir,
      buildRegistry: fakeRegistry({}),
    });
    expect(code1).toBe(0);

    await writeFixture(
      dir,
      "inputs/maybe-brief.md",
      `---
change: maybe-brief
factory: maybe
mode: in-place
---
`,
    );
    const out2 = new BufferStream();
    const err2 = new BufferStream();
    const code2 = await runCli(["run", "maybe-brief"], {
      stdout: out2,
      stderr: err2,
      runCwd: dir,
      buildRegistry: fakeRegistry({}),
    });
    expect(code2).toBe(0);
  });

  it("brief whose factory does not resolve is rejected (exit 1)", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(
      dir,
      "inputs/orphan.md",
      `---
change: orphan
factory: nonexistent
---
`,
    );
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", "orphan"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/Could not resolve factory|nonexistent/i);
  });

  it("schema validation error in factory exits 1", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(
      dir,
      "examples/bad.yaml",
      `name: bad
nodes:
  a:
    terminal: true
edges: []
`,
    );
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", "bad"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
    });
    expect(code).toBe(1);
  });

  it("node failure with no recovery exits 2 and journals the failure", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(
      dir,
      "examples/two.yaml",
      `name: two
brief: none
nodes:
  a:
    executor: test
  b:
    executor: test
    terminal: true
edges:
  - from: a
    to: b
    when: on_success
`,
    );
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", "two"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({
        a: [{ kind: "status", status: "failed" }],
        b: [{ kind: "status", status: "succeeded" }],
      }),
    });
    expect(code).toBe(2);
    expect(err.text()).toMatch(/\[run\] failed cwd=/);
    // failed-runs.json journaled
    const journalRaw = await readFile(path.join(home, "failed-runs.json"), "utf8");
    expect(JSON.parse(journalRaw).entries.length).toBe(1);
  });

  it("budget exhaustion exits 3", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(
      dir,
      "examples/loop.yaml",
      `name: loop
brief: none
nodes:
  a:
    executor: test
    max_iterations: 2
  t:
    executor: test
    terminal: true
edges:
  - from: a
    to: a
    when: on_failure
  - from: a
    to: t
    when: on_success
`,
    );
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", "loop"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({
        a: [{ kind: "status", status: "failed" }],
        t: [{ kind: "status", status: "succeeded" }],
      }),
    });
    expect(code).toBe(3);
  });

  it("serve --help describes the subcommand", async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["serve", "--help"], { stdout: out, stderr: err });
    expect(code).toBe(0);
    expect(out.text() + err.text()).toMatch(/serve/i);
  });

  it("serve refuses a non-loopback host (via the real startDaemon path)", async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["serve", "--host", "0.0.0.0", "."], {
      stdout: out,
      stderr: err,
      serveReturnImmediately: true,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/non-loopback|refuses|0\.0\.0\.0/);
  });

  it("stderr events get a node prefix", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "--in-place", "hello"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({
        a: [
          { kind: "stderr", line: "warn!" },
          { kind: "status", status: "succeeded" },
        ],
      }),
    });
    expect(code).toBe(0);
    expect(err.text()).toContain("[a] warn!");
  });

  describe("worktree-mode run", () => {
    it("creates a worktree and runs the factory inside it", async () => {
      const repo = await makeGitRepoFixture();
      await writeFixture(repo, "examples/sdd.yaml", REQUIRED_FACTORY);
      await writeFixture(
        repo,
        "inputs/my-change.md",
        `---
change: my-change
factory: sdd
base_branch: main
---
`,
      );
      const out = new BufferStream();
      const err = new BufferStream();
      const seenCwds: string[] = [];
      const buildRegistry = (): ExecutorRegistry => {
        const reg = new ExecutorRegistry();
        const exec: NodeExecutor = {
          type: "test",
          async *run(_node: ResolvedNode, ctx: { cwd: string }): AsyncIterable<NodeEvent> {
            seenCwds.push(ctx.cwd);
            yield { kind: "status", status: "succeeded" };
          },
        };
        reg.register(exec);
        return reg;
      };
      const code = await runCli(["run", "my-change"], {
        stdout: out,
        stderr: err,
        runCwd: repo,
        buildRegistry,
      });
      expect(code).toBe(0);
      // Worktree dir lives under MINIFAC_HOME/worktrees
      expect(seenCwds[0]).toContain(path.join(home, "worktrees"));
      const entries = await readdir(path.join(home, "worktrees"));
      expect(entries.length).toBe(1);
      // Branch should exist on the source repo
      const branches = spawnSync("git", ["branch", "--list", "my-change"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(branches.stdout).toMatch(/my-change/);
    });

    it("a second concurrent claim of the same key is refused (exit 1)", async () => {
      const repo = await makeGitRepoFixture();
      await writeFixture(repo, "examples/sdd.yaml", REQUIRED_FACTORY);
      await writeFixture(
        repo,
        "inputs/c.md",
        `---
change: c
factory: sdd
base_branch: main
---
`,
      );
      // Pre-seed the lockfile with our own (live) PID so the second claim
      // throws LockHeldError.
      const { computeRepoHash, worktreeKeyForBrief, lockPathForKey } = await import(
        "./worktree/paths.js"
      );
      const { loadWorktreeConfig } = await import("./worktree/config.js");
      const cfg = await loadWorktreeConfig(repo);
      const hash = await computeRepoHash(repo);
      const key = worktreeKeyForBrief(hash, "c");
      const lockPath = lockPathForKey(cfg, key);
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, `${process.pid}\n`, "utf8");

      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "c"], {
        stdout: out,
        stderr: err,
        runCwd: repo,
        buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "succeeded" }] }),
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/Another minifac run is in progress/);
    });

    it("--in-place claims a lock but skips worktree creation", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "--in-place", "hello"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "succeeded" }] }),
      });
      expect(code).toBe(0);
      // No worktrees dir should be created under home
      let createdWorktrees = false;
      try {
        const e = await readdir(path.join(home, "worktrees"));
        createdWorktrees = e.length > 0;
      } catch {
        createdWorktrees = false;
      }
      expect(createdWorktrees).toBe(false);
    });

    it("brief `mode: in-place` is equivalent to --in-place", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(dir, "examples/sdd.yaml", REQUIRED_FACTORY);
      await writeFixture(
        dir,
        "inputs/foo.md",
        `---
change: foo
factory: sdd
mode: in-place
---
`,
      );
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "foo"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "succeeded" }] }),
      });
      expect(code).toBe(0);
    });

    it("emits a final stderr summary line on success and on failure", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
      const outOk = new BufferStream();
      const errOk = new BufferStream();
      await runCli(["run", "--in-place", "hello"], {
        stdout: outOk,
        stderr: errOk,
        runCwd: dir,
        buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "succeeded" }] }),
      });
      expect(errOk.text()).toMatch(/\[run\] succeeded cwd=/);

      const outFail = new BufferStream();
      const errFail = new BufferStream();
      await runCli(["run", "--in-place", "hello"], {
        stdout: outFail,
        stderr: errFail,
        runCwd: dir,
        buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "failed" }] }),
      });
      expect(errFail.text()).toMatch(/\[run\] failed cwd=/);
    });
  });

  describe("prune subcommand", () => {
    it("no flags prints a summary and exits 0", async () => {
      const dir = await makeFixtureDir();
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["prune"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
      });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/Pruned: merged-old=0/);
    });

    it("--older-than nonsense is a usage error (exit 1)", async () => {
      const dir = await makeFixtureDir();
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["prune", "--older-than", "nonsense"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/Invalid --older-than/);
    });

    it("accepts --all --failed --older-than 30d", async () => {
      const dir = await makeFixtureDir();
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["prune", "--all", "--failed", "--older-than", "30d"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
      });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/Pruned:/);
    });
  });

  describe("factory composition", () => {
    it("brief with `factory: sdd` resolves to the local custom when present", async () => {
      const dir = await makeFixtureDir();
      // Built-in `examples/sdd.yaml` with one prompt.
      await writeFixture(
        dir,
        "examples/sdd.yaml",
        `name: sdd
brief: required
nodes:
  a:
    executor: test
    terminal: true
    with:
      prompt: from-builtin
edges: []
`,
      );
      // Local custom factory overrides the prompt.
      await writeFixture(
        dir,
        ".minifac/factories/sdd.yaml",
        `extends: "minifac:sdd"
nodes:
  a:
    executor: test
    terminal: true
    with:
      prompt: from-local
`,
      );
      await writeFixture(
        dir,
        "inputs/my-change.md",
        `---
change: my-change
factory: sdd
mode: in-place
---
the body
`,
      );
      const captured: string[] = [];
      const buildRegistry = (): ExecutorRegistry => {
        const reg = new ExecutorRegistry();
        const exec: NodeExecutor = {
          type: "test",
          async *run(node: ResolvedNode): AsyncIterable<NodeEvent> {
            captured.push(typeof node.with?.prompt === "string" ? node.with.prompt : "");
            yield { kind: "status", status: "succeeded" };
          },
        };
        reg.register(exec);
        return reg;
      };
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "my-change"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry,
      });
      expect(code).toBe(0);
      expect(captured).toEqual(["from-local"]);
    });

    it("brief with `factory: minifac:sdd` resolves to the built-in even when a local exists", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(
        dir,
        "examples/sdd.yaml",
        `name: sdd
brief: required
nodes:
  a:
    executor: test
    terminal: true
    with:
      prompt: from-builtin
edges: []
`,
      );
      await writeFixture(
        dir,
        ".minifac/factories/sdd.yaml",
        `extends: "minifac:sdd"
nodes:
  a:
    executor: test
    terminal: true
    with:
      prompt: from-local
`,
      );
      await writeFixture(
        dir,
        "inputs/my-change.md",
        `---
change: my-change
factory: minifac:sdd
mode: in-place
---
the body
`,
      );
      const captured: string[] = [];
      const buildRegistry = (): ExecutorRegistry => {
        const reg = new ExecutorRegistry();
        const exec: NodeExecutor = {
          type: "test",
          async *run(node: ResolvedNode): AsyncIterable<NodeEvent> {
            captured.push(typeof node.with?.prompt === "string" ? node.with.prompt : "");
            yield { kind: "status", status: "succeeded" };
          },
        };
        reg.register(exec);
        return reg;
      };
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "my-change"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry,
      });
      expect(code).toBe(0);
      expect(captured).toEqual(["from-builtin"]);
    });
  });
});
