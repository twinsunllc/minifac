import { mkdtemp, writeFile } from "node:fs/promises";
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

async function writeTmp(content: string, name = "f.yaml"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-cli-"));
  const p = path.join(dir, name);
  await writeFile(p, content, "utf8");
  return p;
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

  it("missing file exits 1 with stderr message", async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", path.join(tmpdir(), "no-such-minifac-xyz.yaml")], {
      stdout: out,
      stderr: err,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/Could not read|loading factory/i);
  });

  it("schema validation error exits 1", async () => {
    const file = await writeTmp(`name: bad
nodes:
  a:
    terminal: true
edges: []
`);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", file], { stdout: out, stderr: err });
    expect(code).toBe(1);
  });

  it("valid factory with test executor runs end-to-end (exit 0, prefixed output)", async () => {
    const file = await writeTmp(`name: ok
nodes:
  a:
    executor: test
    terminal: true
edges: []
`);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", file], {
      stdout: out,
      stderr: err,
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

  it("node failure with no recovery exits 2", async () => {
    const file = await writeTmp(`name: f
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
`);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", file], {
      stdout: out,
      stderr: err,
      buildRegistry: fakeRegistry({
        a: [{ kind: "status", status: "failed" }],
        b: [{ kind: "status", status: "succeeded" }],
      }),
    });
    expect(code).toBe(2);
  });

  it("budget exhaustion exits 3", async () => {
    const file = await writeTmp(`name: f
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
`);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", file], {
      stdout: out,
      stderr: err,
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
    const file = await writeTmp(`name: ok
nodes:
  a:
    executor: test
    terminal: true
edges: []
`);
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(["run", file], {
      stdout: out,
      stderr: err,
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
