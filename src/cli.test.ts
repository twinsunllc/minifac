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
      // Per-run worktree directory: `run-<change>-<slug>`.
      expect(entries[0]).toMatch(/^run-my-change-[0-9a-f]{6}$/);
      // Per-run branch: `run/<change>-<slug>`.
      const branches = spawnSync("git", ["branch", "--list", "run/my-change-*"], {
        cwd: repo,
        encoding: "utf8",
      });
      expect(branches.stdout).toMatch(/run\/my-change-[0-9a-f]{6}/);
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
      // The brief above declares `factory: sdd`; the lockfile key for a
      // brief-driven run is `<repo-hash>-<change>-<factoryName>`.
      const key = worktreeKeyForBrief(hash, "c", "sdd");
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
      // Clarification + pointer to --factory override.
      expect(err.text()).toMatch(/lockfile serializes same-change invocations/);
      expect(err.text()).toMatch(/--factory/);
      expect(err.text()).toMatch(/0020-Factory-Override-At-Invocation/);
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
    it("brief with `factory: <name>` resolves to the local custom when present", async () => {
      const dir = await makeFixtureDir();
      // Built-in-style `examples/myfac.yaml` with one prompt. (Use a name
      // that is NOT bundled in the install root so the test fixture wins
      // when the local `.minifac/factories/myfac.yaml` extends `minifac:myfac`.)
      await writeFixture(
        dir,
        "examples/myfac.yaml",
        `name: myfac
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
        ".minifac/factories/myfac.yaml",
        `extends: "minifac:myfac"
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
factory: myfac
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

    it("brief with `factory: minifac:<name>` resolves to the built-in even when a local exists", async () => {
      const dir = await makeFixtureDir();
      // Use a not-bundled name so the source-tree examples/ fallback path
      // is exercised (and the install-root won't accidentally shadow it).
      await writeFixture(
        dir,
        "examples/myfac.yaml",
        `name: myfac
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
        ".minifac/factories/myfac.yaml",
        `extends: "minifac:myfac"
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
factory: minifac:myfac
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

  describe("--factory override", () => {
    const SDD_FACTORY = `name: sdd
brief: required
nodes:
  a:
    executor: test
    terminal: true
    with:
      prompt: from-sdd
edges: []
`;
    const BAR_FACTORY = `name: bar
brief: required
nodes:
  a:
    executor: test
    terminal: true
    with:
      prompt: from-bar
edges: []
`;

    it("no flag — uses brief's declared factory; runs.db row carries declared factory", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(dir, "examples/sdd.yaml", SDD_FACTORY);
      await writeFixture(
        dir,
        "inputs/foo.md",
        `---
change: foo
factory: sdd
mode: in-place
---
body
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
      const code = await runCli(["run", "foo"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry,
      });
      expect(code).toBe(0);
      expect(captured).toEqual(["from-sdd"]);
      const { SqliteRunStore } = await import("./storage/sqlite.js");
      const store = SqliteRunStore.open(path.join(home, "runs.db"));
      try {
        const runs = await store.listRuns({ limit: 10 });
        expect(runs[0]?.factoryName).toBe("sdd");
      } finally {
        await store.close();
      }
    });

    it("--factory bar — resolves through resolveFactoryByName; brief file unchanged", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(dir, "examples/sdd.yaml", SDD_FACTORY);
      await writeFixture(dir, "examples/bar.yaml", BAR_FACTORY);
      const briefPath = await writeFixture(
        dir,
        "inputs/foo.md",
        `---
change: foo
factory: sdd
mode: in-place
---
body
`,
      );
      const beforeBytes = await readFile(briefPath, "utf8");
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
      const code = await runCli(["run", "foo", "--factory", "bar"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry,
      });
      expect(code).toBe(0);
      expect(captured).toEqual(["from-bar"]);
      const afterBytes = await readFile(briefPath, "utf8");
      expect(afterBytes).toBe(beforeBytes);
      const { SqliteRunStore } = await import("./storage/sqlite.js");
      const store = SqliteRunStore.open(path.join(home, "runs.db"));
      try {
        const runs = await store.listRuns({ limit: 10 });
        expect(runs[0]?.factoryName).toBe("bar");
        expect(runs[0]?.factoryPath).toContain("examples/bar.yaml");
      } finally {
        await store.close();
      }
    });

    it("--factory minifac:<name> skips local lookup and resolves to examples/", async () => {
      const dir = await makeFixtureDir();
      // Use `myfac` rather than `sdd` so the source-tree examples/ fallback
      // is the one exercised — the install-root has its own bundled sdd.
      await writeFixture(
        dir,
        "examples/myfac.yaml",
        SDD_FACTORY.replace("name: sdd", "name: myfac"),
      );
      // A same-named local that would win for the bare form; the `minifac:`
      // prefix must skip this.
      await writeFixture(
        dir,
        ".minifac/factories/myfac.yaml",
        `name: myfac
brief: required
nodes:
  a:
    executor: test
    terminal: true
    with:
      prompt: from-local
edges: []
`,
      );
      await writeFixture(
        dir,
        "inputs/foo.md",
        `---
change: foo
factory: myfac
mode: in-place
---
body
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
      const code = await runCli(["run", "foo", "--factory", "minifac:myfac"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry,
      });
      expect(code).toBe(0);
      expect(captured).toEqual(["from-sdd"]);
      const { SqliteRunStore } = await import("./storage/sqlite.js");
      const store = SqliteRunStore.open(path.join(home, "runs.db"));
      try {
        const runs = await store.listRuns({ limit: 10 });
        expect(runs[0]?.factoryName).toBe("myfac");
        expect(runs[0]?.factoryPath).toContain(path.join("examples", "myfac.yaml"));
      } finally {
        await store.close();
      }
    });

    it("--factory nonexistent — exits 1 naming both paths tried, no lock claimed", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(dir, "examples/sdd.yaml", SDD_FACTORY);
      await writeFixture(
        dir,
        "inputs/foo.md",
        `---
change: foo
factory: sdd
mode: in-place
---
body
`,
      );
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "foo", "--factory", "nonexistent"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry: fakeRegistry({}),
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/nonexistent/);
      expect(err.text()).toMatch(/\.minifac\/factories\/nonexistent\.yaml/);
      expect(err.text()).toMatch(/examples\/nonexistent\.yaml/);
      // No lockfile and no runs row.
      let locks: string[] = [];
      try {
        locks = await readdir(path.join(home, "locks"));
      } catch {
        locks = [];
      }
      expect(locks.filter((f) => f.endsWith(".lock"))).toHaveLength(0);
    });

    it("--factory minifac:nonexistent — exits 1 naming only the built-in path tried", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(dir, "examples/sdd.yaml", SDD_FACTORY);
      // A local with the same bare name; the minifac: prefix must not see it.
      await writeFixture(
        dir,
        ".minifac/factories/nonexistent.yaml",
        `name: nonexistent
brief: required
nodes:
  a:
    executor: test
    terminal: true
edges: []
`,
      );
      await writeFixture(
        dir,
        "inputs/foo.md",
        `---
change: foo
factory: sdd
mode: in-place
---
body
`,
      );
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "foo", "--factory", "minifac:nonexistent"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry: fakeRegistry({}),
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/minifac:nonexistent/);
      expect(err.text()).toMatch(/examples\/nonexistent\.yaml/);
      expect(err.text()).not.toMatch(/\.minifac\/factories\/nonexistent\.yaml/);
    });

    it("--factory on a brief-less invocation is a usage error (exit 1)", async () => {
      const dir = await makeFixtureDir();
      await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
      await writeFixture(dir, "examples/sdd.yaml", SDD_FACTORY);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "--in-place", "hello", "--factory", "sdd"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry: fakeRegistry({}),
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/--factory is only meaningful with a brief/);
      let locks: string[] = [];
      try {
        locks = await readdir(path.join(home, "locks"));
      } catch {
        locks = [];
      }
      expect(locks.filter((f) => f.endsWith(".lock"))).toHaveLength(0);
    });

    it("two concurrent runs of same brief through different factories run in parallel", async () => {
      const repo = await makeGitRepoFixture();
      await writeFixture(repo, "examples/sdd.yaml", SDD_FACTORY);
      await writeFixture(repo, "examples/bar.yaml", BAR_FACTORY);
      await writeFixture(
        repo,
        "inputs/foo.md",
        `---
change: foo
factory: sdd
base_branch: main
---
body
`,
      );
      const buildRegistry = (): ExecutorRegistry => {
        const reg = new ExecutorRegistry();
        const exec: NodeExecutor = {
          type: "test",
          async *run(_node: ResolvedNode): AsyncIterable<NodeEvent> {
            // Yield asynchronously so the two invocations actually overlap
            // (the second claims its lock while the first is mid-flight).
            await new Promise((r) => setTimeout(r, 50));
            yield { kind: "status", status: "succeeded" };
          },
        };
        reg.register(exec);
        return reg;
      };
      const out1 = new BufferStream();
      const err1 = new BufferStream();
      const out2 = new BufferStream();
      const err2 = new BufferStream();
      const [c1, c2] = await Promise.all([
        runCli(["run", "foo", "--factory", "sdd"], {
          stdout: out1,
          stderr: err1,
          runCwd: repo,
          buildRegistry,
        }),
        runCli(["run", "foo", "--factory", "bar"], {
          stdout: out2,
          stderr: err2,
          runCwd: repo,
          buildRegistry,
        }),
      ]);
      expect(c1).toBe(0);
      expect(c2).toBe(0);
      // Two distinct worktree directories created.
      const entries = await readdir(path.join(home, "worktrees"));
      const runDirs = entries.filter((e) => e.startsWith("run-foo-"));
      expect(runDirs.length).toBe(2);
      // Two distinct branches.
      const branches = spawnSync("git", ["branch", "--list", "run/foo-*"], {
        cwd: repo,
        encoding: "utf8",
      });
      const branchLines = branches.stdout
        .split("\n")
        .map((l) => l.trim().replace(/^\*\s*/, ""))
        .filter((l) => l.length > 0);
      expect(branchLines.length).toBe(2);
      // Both runs persisted, both with distinct factoryName.
      const { SqliteRunStore } = await import("./storage/sqlite.js");
      const store = SqliteRunStore.open(path.join(home, "runs.db"));
      try {
        const runs = await store.listRuns({ change: "foo", limit: 10 });
        expect(runs.length).toBe(2);
        const names = new Set(runs.map((r) => r.factoryName));
        expect(names).toEqual(new Set(["sdd", "bar"]));
        expect(runs.every((r) => r.status === "succeeded")).toBe(true);
      } finally {
        await store.close();
      }
    });

    it("two concurrent runs of same (brief, factory) — one wins lock, other exits 1 with wider key", async () => {
      const repo = await makeGitRepoFixture();
      await writeFixture(repo, "examples/sdd.yaml", SDD_FACTORY);
      await writeFixture(
        repo,
        "inputs/foo.md",
        `---
change: foo
factory: sdd
base_branch: main
---
body
`,
      );
      // Pre-seed the wider-key lockfile to force the new run to refuse.
      const { computeRepoHash, worktreeKeyForBrief, lockPathForKey } = await import(
        "./worktree/paths.js"
      );
      const { loadWorktreeConfig } = await import("./worktree/config.js");
      const cfg = await loadWorktreeConfig(repo);
      const hash = await computeRepoHash(repo);
      const key = worktreeKeyForBrief(hash, "foo", "sdd");
      const lockPath = lockPathForKey(cfg, key);
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, `${process.pid}\n`, "utf8");

      const out = new BufferStream();
      const err = new BufferStream();
      const code = await runCli(["run", "foo", "--factory", "sdd"], {
        stdout: out,
        stderr: err,
        runCwd: repo,
        buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "succeeded" }] }),
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/Another minifac run is in progress/);
      // Wider key is named in the message.
      expect(err.text()).toContain(`${hash}-foo-sdd`);
    });
  });

  describe("run history persistence", () => {
    it("creates a runs row and persisted events for an --in-place run", async () => {
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
            { kind: "stdout", line: "one" },
            { kind: "stdout", line: "two" },
            { kind: "status", status: "succeeded" },
          ],
        }),
      });
      expect(code).toBe(0);

      // Inspect the SQLite runs.db at ${MINIFAC_HOME}/runs.db.
      const { SqliteRunStore } = await import("./storage/sqlite.js");
      const store = SqliteRunStore.open(path.join(home, "runs.db"));
      try {
        const runs = await store.listRuns({ limit: 10 });
        expect(runs.length).toBe(1);
        const r = runs[0];
        expect(r?.status).toBe("succeeded");
        expect(r?.factoryName).toBe("hello");
        expect(r?.endedAt).not.toBeNull();
        const events = await store.getRunEvents(r?.id ?? "");
        expect(events.map((e) => e.kind)).toEqual(["stdout", "stdout", "status"]);
        expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
      } finally {
        await store.close();
      }
    });
  });
});
