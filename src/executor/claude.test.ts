import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ClaudeExecutor,
  SENTINEL_INSTRUCTIONS,
  buildCliArgs,
  buildStreamJsonInput,
} from "./claude.js";
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
    priorResults: [],
    nodeId: "n1",
    iteration: 1,
    cwd: "/tmp",
    outputsDir: "/tmp/outputs",
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
  it("matches the v0 wire-format snapshot for empty priorResults", () => {
    const out = buildStreamJsonInput([], "say hi");
    expect(out).toMatchInlineSnapshot(`
      "{"type":"user","message":{"role":"user","content":"[]\\n\\n---\\n\\nsay hi"}}
      "
    `);
  });

  it("matches the v0 wire-format snapshot for populated priorResults", () => {
    const out = buildStreamJsonInput(
      [
        {
          nodeId: "a",
          iteration: 1,
          status: "succeeded",
          reason: null,
          startedAt: 0,
          endedAt: 12,
          outputs: null,
          nudges_used: 0,
        },
        {
          nodeId: "v",
          iteration: 1,
          status: "failed",
          reason: "verify hit error",
          startedAt: 13,
          endedAt: 20,
          outputs: null,
          nudges_used: 0,
        },
      ],
      "prompt here",
    );
    expect(out).toMatchInlineSnapshot(`
      "{"type":"user","message":{"role":"user","content":"[{\\"nodeId\\":\\"a\\",\\"iteration\\":1,\\"status\\":\\"succeeded\\",\\"reason\\":null,\\"startedAt\\":0,\\"endedAt\\":12,\\"outputs\\":null,\\"nudges_used\\":0},{\\"nodeId\\":\\"v\\",\\"iteration\\":1,\\"status\\":\\"failed\\",\\"reason\\":\\"verify hit error\\",\\"startedAt\\":13,\\"endedAt\\":20,\\"outputs\\":null,\\"nudges_used\\":0}]\\n\\n---\\n\\nprompt here"}}
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
      priorResults: [
        {
          nodeId: "prev",
          iteration: 1,
          status: "failed",
          reason: "earlier failure",
          startedAt: 0,
          endedAt: 1,
          outputs: null,
          nudges_used: 0,
        },
      ],
    });
    await collect(executor, makeNode({ with: { prompt: "what next?" } }), ctx);
    expect(cwdSeen).toBe("/some/workdir");
    const stdinSent = captured ? (captured as FakeChild).stdinWritten : "";
    expect(stdinSent).toContain("earlier failure");
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

  it("emits --mcp-config when an mcpConfigPath is passed in", () => {
    const args = buildCliArgs({ prompt: "hi" }, "/tmp/x/.mcp.json");
    const idx = args.indexOf("--mcp-config");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("/tmp/x/.mcp.json");
  });

  it("places --mcp-config before authority knobs and passthrough", () => {
    const args = buildCliArgs(
      {
        prompt: "hi",
        permission_mode: "bypass_permissions",
        args: ["--debug"],
      },
      "/tmp/x/.mcp.json",
    );
    const mcpIdx = args.indexOf("--mcp-config");
    const authIdx = args.indexOf("--permission-mode");
    const passthroughIdx = args.indexOf("--debug");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeGreaterThan(mcpIdx);
    expect(passthroughIdx).toBeGreaterThan(authIdx);
  });

  it("omits --mcp-config when mcpConfigPath is undefined", () => {
    const args = buildCliArgs({ prompt: "hi" });
    expect(args).not.toContain("--mcp-config");
  });

  it("omits --mcp-config when mcpConfigPath is an empty string", () => {
    const args = buildCliArgs({ prompt: "hi" }, "");
    expect(args).not.toContain("--mcp-config");
  });
});

describe("ClaudeExecutor MCP wiring", () => {
  it("forwards ctx.mcpConfigPath to the spawned CLI as --mcp-config <path>", async () => {
    let argsSeen: readonly string[] | null = null;
    const executor = new ClaudeExecutor({
      spawn: (_bin, args, _opts) => {
        argsSeen = args;
        const c = makeFakeChild();
        setImmediate(() => c.finish(0));
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const ctx = makeCtx({ mcpConfigPath: "/tmp/abc/.mcp.json" });
    await collect(executor, makeNode(), ctx);
    expect(argsSeen).not.toBeNull();
    const idx = (argsSeen as readonly string[]).indexOf("--mcp-config");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect((argsSeen as readonly string[])[idx + 1]).toBe("/tmp/abc/.mcp.json");
  });

  it("omits --mcp-config when ctx.mcpConfigPath is undefined (unit-test path)", async () => {
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
    expect(argsSeen).not.toContain("--mcp-config");
  });

  it("supportsMcp is true on the Claude executor", () => {
    expect(new ClaudeExecutor().supportsMcp).toBe(true);
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

  it("response-side sentinel parse is unaffected by emit_sentinel_instructions: false", async () => {
    // Injection and parsing are independent: opting out of the appended
    // block does NOT disable the executor's scan of the final result event.
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        setImmediate(() => {
          c.emitOutput(
            resultEventLine("Did the work.\nMINIFAC_STATUS: failed\nREASON: opted out anyway"),
          );
          c.finish(0);
        });
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    const events = await collect(
      executor,
      makeNode({ with: { prompt: "hi", emit_sentinel_instructions: false } }),
      makeCtx(),
    );
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      kind: "status",
      status: "failed",
      meta: {
        reason: "sentinel_failed",
        sentinel: "opted out anyway",
        exitCode: 0,
      },
    });
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

/**
 * Pull the user-message content out of the stdin envelope an executor would
 * have written. Mirrors the shape `buildStreamJsonInput` writes — see the
 * wire-format comment at the top of `src/executor/claude.ts`.
 */
function userMessageContentFromStdin(stdin: string): string {
  const line = stdin.endsWith("\n") ? stdin.slice(0, -1) : stdin;
  const parsed = JSON.parse(line) as {
    type: string;
    message: { role: string; content: string };
  };
  return parsed.message.content;
}

describe("ClaudeExecutor sentinel-instruction injection", () => {
  it("auto-appends SENTINEL_INSTRUCTIONS by default (omitted field) — snapshot", async () => {
    let captured: FakeChild | null = null;
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        captured = c;
        setImmediate(() => c.finish(0));
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    await collect(executor, makeNode({ with: { prompt: "do X" } }), makeCtx());
    const stdin = captured ? (captured as FakeChild).stdinWritten : "";
    expect(stdin).toMatchInlineSnapshot(`
      "{"type":"user","message":{"role":"user","content":"[]\\n\\n---\\n\\ndo X\\n\\n## Status signaling\\n\\nYour final assistant message MUST end with a \`MINIFAC_STATUS:\` line\\nthat tells the runner whether this node succeeded or failed. The\\nrunner reads this line out of your final assistant text; nothing\\nelse in the message decides the outcome.\\n\\n- On success, end your final message with exactly this line and\\n  nothing after it:\\n\\n      MINIFAC_STATUS: succeeded\\n\\n- On failure, end your final message with exactly these two lines\\n  and nothing after them:\\n\\n      MINIFAC_STATUS: failed\\n      REASON: <one-line description of what blocked the node>\\n\\nThe \`MINIFAC_STATUS:\` line MUST be the last thing in your final\\nassistant message."}}
      "
    `);
    // Sanity: the injected block is byte-identical to the exported constant.
    const content = userMessageContentFromStdin(stdin);
    expect(content.endsWith(SENTINEL_INSTRUCTIONS)).toBe(true);
  });

  it("emit_sentinel_instructions: false sends the bare prompt", async () => {
    let captured: FakeChild | null = null;
    const executor = new ClaudeExecutor({
      spawn: () => {
        const c = makeFakeChild();
        captured = c;
        setImmediate(() => c.finish(0));
        return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
      },
    });
    await collect(
      executor,
      makeNode({ with: { prompt: "do X", emit_sentinel_instructions: false } }),
      makeCtx(),
    );
    const stdin = captured ? (captured as FakeChild).stdinWritten : "";
    const content = userMessageContentFromStdin(stdin);
    expect(content).toBe("[]\n\n---\n\ndo X");
    expect(content).not.toContain("MINIFAC_STATUS");
  });

  it("emit_sentinel_instructions: true produces the same payload as omitted", async () => {
    const captureStdin = async (withPayload: Record<string, unknown>): Promise<string> => {
      let captured: FakeChild | null = null;
      const executor = new ClaudeExecutor({
        spawn: () => {
          const c = makeFakeChild();
          captured = c;
          setImmediate(() => c.finish(0));
          return c as unknown as ReturnType<typeof import("node:child_process").spawn>;
        },
      });
      await collect(executor, makeNode({ with: withPayload }), makeCtx());
      return captured ? (captured as FakeChild).stdinWritten : "";
    };
    const omitted = await captureStdin({ prompt: "do X" });
    const explicitTrue = await captureStdin({ prompt: "do X", emit_sentinel_instructions: true });
    expect(explicitTrue).toBe(omitted);
  });

  it("non-boolean emit_sentinel_instructions yields invalid_with and no spawn", async () => {
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
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid `with:` for the test
      makeNode({ with: { prompt: "hi", emit_sentinel_instructions: "yes" as any } }),
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
