import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeExecutor, buildCliArgs, buildStreamJsonInput } from "./claude.js";
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

  it("captures argv passed to spawn and honors cwd", async () => {
    // sanity test: spawn receives the args we built.
    let argsSeen: readonly string[] | null = null;
    const executor = new ClaudeExecutor({
      spawn: (_bin, args, _opts) => {
        argsSeen = args;
        const c = makeFakeChild();
        setImmediate(() => c.finish(0));
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    await collect(executor, makeNode(), makeCtx());
    expect(argsSeen).not.toBeNull();
    expect(argsSeen).toEqual(buildCliArgs({ prompt: "hello" }));
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

describe("buildCliArgs", () => {
  it("locks the pre-change argv for a defaults-only payload (snapshot)", () => {
    expect(buildCliArgs({ prompt: "hi" })).toMatchInlineSnapshot(`
      [
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ]
    `);
  });

  it("locks argv with all three authority knobs set (snapshot)", () => {
    expect(
      buildCliArgs({
        prompt: "hi",
        permission_mode: "accept_edits",
        allowed_tools: ["Bash(openspec:*)", "Write"],
        add_dirs: ["/tmp/x", "/tmp/y"],
      }),
    ).toMatchInlineSnapshot(`
      [
        "--print",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Bash(openspec:*),Write",
        "--add-dir",
        "/tmp/x",
        "--add-dir",
        "/tmp/y",
      ]
    `);
  });

  it("maps permission_mode accept_edits to --permission-mode acceptEdits", () => {
    const args = buildCliArgs({ prompt: "hi", permission_mode: "accept_edits" });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("acceptEdits");
  });

  it("maps permission_mode bypass_permissions to --permission-mode bypassPermissions", () => {
    const args = buildCliArgs({ prompt: "hi", permission_mode: "bypass_permissions" });
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("bypassPermissions");
  });

  it("emits no --permission-mode flag when permission_mode is default", () => {
    const args = buildCliArgs({ prompt: "hi", permission_mode: "default" });
    expect(args).not.toContain("--permission-mode");
  });

  it("joins allowed_tools on comma as a single --allowedTools value", () => {
    const args = buildCliArgs({ prompt: "hi", allowed_tools: ["Bash", "Edit"] });
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("Bash,Edit");
    // exactly one occurrence:
    expect(args.filter((a) => a === "--allowedTools")).toHaveLength(1);
  });

  it("repeats --add-dir once per add_dirs entry, in order", () => {
    const args = buildCliArgs({ prompt: "hi", add_dirs: ["/a", "/b"] });
    // Find both pairs:
    const firstFlag = args.indexOf("--add-dir");
    expect(firstFlag).toBeGreaterThanOrEqual(0);
    expect(args[firstFlag + 1]).toBe("/a");
    const secondFlag = args.indexOf("--add-dir", firstFlag + 1);
    expect(secondFlag).toBeGreaterThanOrEqual(0);
    expect(args[secondFlag + 1]).toBe("/b");
    // Exactly two occurrences:
    expect(args.filter((a) => a === "--add-dir")).toHaveLength(2);
  });

  it("emits no --add-dir when add_dirs is an empty array", () => {
    const args = buildCliArgs({ prompt: "hi", add_dirs: [] });
    expect(args).not.toContain("--add-dir");
  });

  it("emits no --allowedTools when allowed_tools is an empty array", () => {
    const args = buildCliArgs({ prompt: "hi", allowed_tools: [] });
    expect(args).not.toContain("--allowedTools");
  });

  it("places typed flags before with.args passthrough", () => {
    const args = buildCliArgs({
      prompt: "hi",
      permission_mode: "bypass_permissions",
      args: ["--debug"],
    });
    const typedIdx = args.indexOf("--permission-mode");
    const passthroughIdx = args.indexOf("--debug");
    expect(typedIdx).toBeGreaterThanOrEqual(0);
    expect(passthroughIdx).toBeGreaterThan(typedIdx);
  });
});

describe("ClaudeExecutor with: validation", () => {
  it("rejects unknown permission_mode and spawns no child", async () => {
    let spawned = false;
    const executor = new ClaudeExecutor({
      spawn: () => {
        spawned = true;
        const c = makeFakeChild();
        setImmediate(() => c.finish(0));
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(
      executor,
      makeNode({ with: { prompt: "hi", permission_mode: "yolo" } }),
      makeCtx(),
    );
    expect(spawned).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "status",
      status: "failed",
      meta: { reason: "invalid_with" },
    });
  });

  it("rejects empty-string element in allowed_tools and spawns no child", async () => {
    let spawned = false;
    const executor = new ClaudeExecutor({
      spawn: () => {
        spawned = true;
        const c = makeFakeChild();
        setImmediate(() => c.finish(0));
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(
      executor,
      makeNode({ with: { prompt: "hi", allowed_tools: ["Write", ""] } }),
      makeCtx(),
    );
    expect(spawned).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "status",
      status: "failed",
      meta: { reason: "invalid_with" },
    });
  });

  it("rejects empty-string element in add_dirs and spawns no child", async () => {
    let spawned = false;
    const executor = new ClaudeExecutor({
      spawn: () => {
        spawned = true;
        const c = makeFakeChild();
        setImmediate(() => c.finish(0));
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(
      executor,
      makeNode({ with: { prompt: "hi", add_dirs: [""] } }),
      makeCtx(),
    );
    expect(spawned).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "status",
      status: "failed",
      meta: { reason: "invalid_with" },
    });
  });
});

/** Build one stream-json `result` event line for the test stdout. */
function resultEventLine(resultText: string): string {
  return JSON.stringify({ type: "result", result: resultText });
}

describe("ClaudeExecutor sentinel status", () => {
  it("MINIFAC_STATUS: failed overrides exit 0 and captures REASON", async () => {
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          c.emitOutput(
            resultEventLine("Did some looking.\nMINIFAC_STATUS: failed\nREASON: nothing got done"),
          );
          c.finish(0);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      kind: "status",
      status: "failed",
      meta: {
        reason: "sentinel_failed",
        sentinel: "nothing got done",
        exitCode: 0,
      },
    });
  });

  it("MINIFAC_STATUS: succeeded beats a non-zero exit code", async () => {
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          c.emitOutput(resultEventLine("All good.\nMINIFAC_STATUS: succeeded"));
          c.finish(1);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      kind: "status",
      status: "succeeded",
      meta: { reason: "sentinel_succeeded", exitCode: 1 },
    });
  });

  it("MINIFAC_STATUS: succeeded with exit 0 emits sentinel_succeeded", async () => {
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          c.emitOutput(resultEventLine("Finished.\nMINIFAC_STATUS: succeeded"));
          c.finish(0);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      kind: "status",
      status: "succeeded",
      meta: { reason: "sentinel_succeeded", exitCode: 0 },
    });
  });

  it("no sentinel + exit 0 → succeeded with exitCode meta (unchanged shape)", async () => {
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          c.emitOutput(resultEventLine("All done with no sentinel."));
          c.finish(0);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    const last = events[events.length - 1];
    expect(last).toEqual({ kind: "status", status: "succeeded", meta: { exitCode: 0 } });
  });

  it("non-JSON stdout lines are still emitted and don't break sentinel detection", async () => {
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          c.emitOutput("not json at all");
          c.emitOutput(resultEventLine("Done.\nMINIFAC_STATUS: failed\nREASON: bad day"));
          c.finish(0);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    expect(events[0]).toEqual({ kind: "stdout", line: "not json at all" });
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      kind: "status",
      status: "failed",
      meta: { reason: "sentinel_failed", sentinel: "bad day", exitCode: 0 },
    });
  });

  it("sentinel in an EARLIER assistant turn is ignored; final result wins", async () => {
    // Two `result` events on the wire; only the final one's content is used
    // for sentinel detection. (The CLI emits one result event per session in
    // practice, but the executor's contract is "last one wins" so we test
    // that explicitly.)
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          // Earlier "result" carrying a failed sentinel — must be ignored.
          c.emitOutput(resultEventLine("First pass.\nMINIFAC_STATUS: failed"));
          // Final "result" event — no sentinel — falls back to exit code.
          c.emitOutput(resultEventLine("Second pass succeeded with no marker."));
          c.finish(0);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    const last = events[events.length - 1];
    expect(last).toEqual({ kind: "status", status: "succeeded", meta: { exitCode: 0 } });
  });

  it("non-result stream-json events do not affect sentinel detection", async () => {
    // Lines that parse as JSON but are not `type: result` are ignored for
    // sentinel purposes — even if their text contains MINIFAC_STATUS.
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          c.emitOutput(
            JSON.stringify({
              type: "assistant",
              message: { content: "MINIFAC_STATUS: failed" },
            }),
          );
          c.finish(0);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(executor, makeNode(), makeCtx());
    const last = events[events.length - 1];
    expect(last).toEqual({ kind: "status", status: "succeeded", meta: { exitCode: 0 } });
  });
});
