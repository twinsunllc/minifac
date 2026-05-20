import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
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
    const code = await runCli(["run", "no-such-thing"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/Could not resolve/i);
  });

  it("factory-by-name (brief: none) runs end-to-end (exit 0, prefixed output)", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "hello"], {
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

  it("brief-by-path runs end-to-end", async () => {
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
    const code = await runCli(["run", briefPath], {
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
    // No error message about brief-required-but-missing — proves the brief
    // was resolved at step 2 rather than the factory at step 3.
    expect(err.text()).not.toMatch(/requires a brief/);
  });

  it("brief: required factory invoked brief-less is rejected (exit 1)", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/sdd.yaml", REQUIRED_FACTORY);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", "sdd"], {
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
    const code1 = await runCli(["run", "maybe"], {
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
    const code = await runCli(["run", "orphan"], {
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
    const code = await runCli(["run", "bad"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
    });
    expect(code).toBe(1);
  });

  it("node failure with no recovery exits 2", async () => {
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
    const code = await runCli(["run", "two"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({
        a: [{ kind: "status", status: "failed" }],
        b: [{ kind: "status", status: "succeeded" }],
      }),
    });
    expect(code).toBe(2);
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
    const code = await runCli(["run", "loop"], {
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
    const code = await runCli(["run", "hello"], {
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
});
