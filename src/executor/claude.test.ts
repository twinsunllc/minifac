import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeExecutor, buildStreamJsonInput } from "./claude.js";
import type { ResolvedNode, RunContext } from "./types.js";

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  emitOutput: (line: string) => void;
  emitErr: (line: string) => void;
  finish: (code: number) => void;
  stdinWritten: string;
}

function makeFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;

  let stdinBuf = "";
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinBuf += chunk.toString();
      cb();
    },
  });
  Object.defineProperty(ee, "stdinWritten", {
    get: () => stdinBuf,
  });

  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  ee.stdin = stdin;
  ee.stdout = stdout;
  ee.stderr = stderr;

  ee.emitOutput = (line) => {
    stdout.push(`${line}\n`);
  };
  ee.emitErr = (line) => {
    stderr.push(`${line}\n`);
  };
  ee.finish = (code) => {
    stdout.push(null);
    stderr.push(null);
    setImmediate(() => ee.emit("exit", code));
  };
  return ee;
}

function makeNode(overrides: Partial<ResolvedNode> = {}): ResolvedNode {
  return {
    id: "n1",
    executor: "claude",
    terminal: false,
    with: { prompt: "hello" },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    factory: {
      name: "f",
      nodes: { n1: { executor: "claude", terminal: false } },
      edges: [],
    },
    history: [],
    nodeId: "n1",
    iteration: 1,
    cwd: "/tmp",
    ...overrides,
  };
}

async function collect(executor: ClaudeExecutor, node: ResolvedNode, ctx: RunContext) {
  const events = [];
  for await (const e of executor.run(node, ctx)) {
    events.push(e);
  }
  return events;
}

describe("buildStreamJsonInput", () => {
  it("matches the v0 wire-format snapshot for an empty history", () => {
    const out = buildStreamJsonInput([], "say hi");
    expect(out).toMatchInlineSnapshot(`
      "{"type":"user","message":{"role":"user","content":"[]\\n\\n---\\n\\nsay hi"}}
      "
    `);
  });

  it("matches the v0 wire-format snapshot for a populated history", () => {
    const out = buildStreamJsonInput(
      [
        {
          nodeId: "a",
          iteration: 1,
          emittedAt: 12,
          event: { kind: "stdout", line: "prior" },
        },
      ],
      "prompt here",
    );
    expect(out).toMatchInlineSnapshot(`
      "{"type":"user","message":{"role":"user","content":"[{\\"nodeId\\":\\"a\\",\\"iteration\\":1,\\"emittedAt\\":12,\\"event\\":{\\"kind\\":\\"stdout\\",\\"line\\":\\"prior\\"}}]\\n\\n---\\n\\nprompt here"}}
      "
    `);
  });
});

describe("ClaudeExecutor", () => {
  it("rejects missing prompt with an invalid_with failure", async () => {
    const fake = makeFakeChild();
    const executor = new ClaudeExecutor({
      spawn: () => fake as unknown as ReturnType<typeof import("node:child_process").spawn>,
    });
    const events = await collect(executor, makeNode({ with: {} }), makeCtx());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "status",
      status: "failed",
      meta: { reason: "invalid_with" },
    });
  });

  it("streams stdout line-by-line and reports succeeded on exit 0", async () => {
    let captured: FakeChild | null = null;
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        captured = c;
        // emit asynchronously after .run() begins reading
        setImmediate(() => {
          c.emitOutput("line-one");
          c.emitOutput("line-two");
          c.finish(0);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });

    const events = await collect(executor, makeNode(), makeCtx());
    expect(events).toEqual([
      { kind: "stdout", line: "line-one" },
      { kind: "stdout", line: "line-two" },
      { kind: "status", status: "succeeded", meta: { exitCode: 0 } },
    ]);
    expect(captured).not.toBeNull();
  });

  it("forwards stderr and reports failed on non-zero exit", async () => {
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          c.emitErr("oops");
          c.finish(1);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    expect(events).toEqual([
      { kind: "stderr", line: "oops" },
      { kind: "status", status: "failed", meta: { exitCode: 1 } },
    ]);
  });

  it("reports missing_binary when spawn raises ENOENT", async () => {
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          const err: NodeJS.ErrnoException = Object.assign(new Error("not found"), {
            code: "ENOENT",
          });
          c.emit("error", err);
          // Some shells then emit exit(null) — simulate that to make sure
          // we still classify correctly.
          c.finish(null as unknown as number);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      kind: "status",
      status: "failed",
      meta: { reason: "missing_binary", binary: "claude" },
    });
  });

  it("writes the stream-json envelope to stdin and honors cwd", async () => {
    let captured: FakeChild | null = null;
    let cwdSeen: string | null = null;
    const executor = new ClaudeExecutor({
      spawn: (_bin, _args, opts) => {
        const c = makeFakeChild();
        captured = c;
        cwdSeen = opts.cwd;
        setImmediate(() => c.finish(0));
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const ctx = makeCtx({
      cwd: "/some/workdir",
      history: [
        {
          nodeId: "prev",
          iteration: 1,
          emittedAt: 1,
          event: { kind: "stdout", line: "earlier output" },
        },
      ],
    });
    await collect(executor, makeNode({ with: { prompt: "what next?" } }), ctx);
    expect(cwdSeen).toBe("/some/workdir");
    const stdinSent = captured ? (captured as FakeChild).stdinWritten : "";
    expect(stdinSent).toContain("earlier output");
    expect(stdinSent).toContain("what next?");
    expect(stdinSent.endsWith("\n")).toBe(true);
  });
});
