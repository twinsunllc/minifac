import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { ExecutorRegistry } from "./executor/registry.js";
import type { EmittedEvent, NodeEvent, NodeExecutor, ResolvedNode } from "./executor/types.js";
import type { InkRunRenderer } from "./tui/renderer.js";

class BufferStream extends Writable {
  chunks: string[] = [];
  isTTY: boolean;
  constructor(opts: { isTTY?: boolean } = {}) {
    super();
    this.isTTY = opts.isTTY ?? false;
  }
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
  return await mkdtemp(path.join(tmpdir(), "minifac-cli-tui-"));
}

async function writeFixture(dir: string, rel: string, contents: string): Promise<void> {
  const filePath = path.join(dir, rel);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
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

interface FakeRenderer {
  renderer: InkRunRenderer;
  events: EmittedEvent[];
  terminated: { status: string; reason?: string } | null;
  resolveExit: (action: "quit" | "raw-switch" | "merge") => void;
}

function makeFakeRenderer(initialAction: "quit" | "raw-switch" | "merge" = "quit"): FakeRenderer {
  const events: EmittedEvent[] = [];
  const fake: FakeRenderer = {
    events,
    terminated: null,
    resolveExit: () => undefined,
    renderer: null as unknown as InkRunRenderer,
  };
  let resolveExit: ((value: { action: "quit" | "raw-switch" | "merge" }) => void) | null = null;
  const exitPromise = new Promise<{ action: "quit" | "raw-switch" | "merge" }>((res) => {
    resolveExit = res;
  });
  fake.resolveExit = (action) => {
    if (resolveExit) {
      const r = resolveExit;
      resolveExit = null;
      r({ action });
    }
  };
  fake.renderer = {
    onEvent: (entry) => {
      events.push(entry);
    },
    waitForExit: () => exitPromise,
    requestQuit: () => fake.resolveExit("quit"),
    terminate: (status, reason) => {
      fake.terminated = { status, ...(reason !== undefined ? { reason } : {}) };
      // Auto-resolve as quit so the CLI proceeds.
      fake.resolveExit(initialAction);
    },
    snapshot: () => {
      throw new Error("not used in tests");
    },
  };
  return fake;
}

describe("runCli — output mode selection", () => {
  let savedHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    home = await mkdtemp(path.join(tmpdir(), "minifac-home-tui-"));
    process.env.MINIFAC_HOME = home;
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be unset
    if (savedHome === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = savedHome;
  });

  it("routes to TUI when stdout.isTTY is true and no flag is supplied", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    const out = new BufferStream({ isTTY: true });
    const err = new BufferStream();
    const fake = makeFakeRenderer();
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
      createTuiRenderer: () => fake.renderer,
    });
    expect(code).toBe(0);
    // Raw formatter not called: stdout has no "[a] hi" line.
    expect(out.text()).not.toContain("[a] hi");
    // Renderer saw the events instead.
    expect(fake.events.some((e) => e.event.kind === "stdout")).toBe(true);
    // Run terminated normally.
    expect(fake.terminated?.status).toBe("succeeded");
    // [run] summary still emitted.
    expect(err.text()).toMatch(/\[run\] succeeded cwd=/);
  });

  it("routes to raw when stdout.isTTY is false and no flag is supplied", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    const out = new BufferStream({ isTTY: false });
    const err = new BufferStream();
    let rendererBuilt = false;
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
      createTuiRenderer: () => {
        rendererBuilt = true;
        return makeFakeRenderer().renderer;
      },
    });
    expect(code).toBe(0);
    expect(rendererBuilt).toBe(false);
    expect(out.text()).toContain("[a] hi");
    expect(err.text()).toMatch(/\[run\] succeeded cwd=/);
  });

  it("--raw forces raw output in a TTY", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    const out = new BufferStream({ isTTY: true });
    const err = new BufferStream();
    let rendererBuilt = false;
    const code = await runCli(["run", "--in-place", "hello", "--raw"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({
        a: [
          { kind: "stdout", line: "hi" },
          { kind: "status", status: "succeeded" },
        ],
      }),
      createTuiRenderer: () => {
        rendererBuilt = true;
        return makeFakeRenderer().renderer;
      },
    });
    expect(code).toBe(0);
    expect(rendererBuilt).toBe(false);
    expect(out.text()).toContain("[a] hi");
  });

  it("--tui forces the TUI in a non-TTY", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    const out = new BufferStream({ isTTY: false });
    const err = new BufferStream();
    const fake = makeFakeRenderer();
    const code = await runCli(["run", "--in-place", "hello", "--tui"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry({
        a: [
          { kind: "stdout", line: "hi" },
          { kind: "status", status: "succeeded" },
        ],
      }),
      createTuiRenderer: () => fake.renderer,
    });
    expect(code).toBe(0);
    expect(out.text()).not.toContain("[a] hi");
    expect(fake.events.length).toBeGreaterThan(0);
  });

  it("--raw and --tui together exits 1 with a flag-conflict message and starts no run", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    const out = new BufferStream({ isTTY: true });
    const err = new BufferStream();
    let executed = false;
    const code = await runCli(["run", "--in-place", "hello", "--raw", "--tui"], {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: () => {
        executed = true;
        return new ExecutorRegistry();
      },
      createTuiRenderer: () => makeFakeRenderer().renderer,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--raw and --tui are mutually exclusive/);
    expect(executed).toBe(false);
  });

  it("emits [run] <status> cwd=<path> summary in both modes", async () => {
    const dir = await makeFixtureDir();
    await writeFixture(dir, "examples/hello.yaml", NONE_FACTORY);
    // raw
    {
      const out = new BufferStream({ isTTY: false });
      const err = new BufferStream();
      await runCli(["run", "--in-place", "hello"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "succeeded" }] }),
      });
      expect(err.text()).toMatch(/\[run\] succeeded cwd=/);
    }
    // tui
    {
      const out = new BufferStream({ isTTY: true });
      const err = new BufferStream();
      const fake = makeFakeRenderer();
      await runCli(["run", "--in-place", "hello"], {
        stdout: out,
        stderr: err,
        runCwd: dir,
        buildRegistry: fakeRegistry({ a: [{ kind: "status", status: "succeeded" }] }),
        createTuiRenderer: () => fake.renderer,
      });
      expect(err.text()).toMatch(/\[run\] succeeded cwd=/);
    }
  });
});

describe("pickOutputMode", () => {
  // Re-import via dynamic to keep import block sorted
  it("respects flag precedence and TTY auto-detection", async () => {
    const { pickOutputMode } = await import("./cli.js");
    const ttyOut = {
      stdout: { isTTY: true } as unknown as NodeJS.WritableStream & { isTTY?: boolean },
    };
    const pipeOut = {
      stdout: { isTTY: false } as unknown as NodeJS.WritableStream & { isTTY?: boolean },
    };
    expect(pickOutputMode({ raw: true }, ttyOut)).toBe("raw");
    expect(pickOutputMode({ tui: true }, pipeOut)).toBe("tui");
    expect(pickOutputMode({}, ttyOut)).toBe("tui");
    expect(pickOutputMode({}, pipeOut)).toBe("raw");
  });
});
