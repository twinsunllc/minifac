import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { AutorunEvent } from "./cli/autorun.js";
import type { EmittedEvent } from "./executor/types.js";
import { SqliteRunStore } from "./storage/sqlite.js";
import type { BriefListState } from "./tui/autorun-reducer.js";
import type { AutorunRendererExitInfo, InkAutorunRenderer } from "./tui/autorun-renderer.js";

class BufferStream extends Writable {
  chunks: string[] = [];
  isTTY: boolean;
  constructor(opts: { isTTY?: boolean } = {}) {
    super();
    this.isTTY = opts.isTTY ?? false;
  }
  // biome-ignore lint/suspicious/noExplicitAny: stream signature
  _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

interface FakeAutorunRenderer {
  renderer: InkAutorunRenderer;
  autorunEvents: AutorunEvent[];
  runEvents: Array<{ change: string; entry: EmittedEvent }>;
  resolveExit: (info: AutorunRendererExitInfo) => void;
}

function makeFakeAutorunRenderer(exitOnFirstStarted = true): FakeAutorunRenderer {
  const autorunEvents: AutorunEvent[] = [];
  const runEvents: Array<{ change: string; entry: EmittedEvent }> = [];
  let resolveExit: ((value: AutorunRendererExitInfo) => void) | null = null;
  const exitPromise = new Promise<AutorunRendererExitInfo>((res) => {
    resolveExit = res;
  });
  const doResolve = (info: AutorunRendererExitInfo): void => {
    if (resolveExit) {
      const r = resolveExit;
      resolveExit = null;
      r(info);
    }
  };
  const renderer: InkAutorunRenderer = {
    onEvent: (event) => {
      autorunEvents.push(event);
      if (exitOnFirstStarted && event.kind === "started") {
        // Auto-quit after first started so the autorun action can proceed.
        setTimeout(() => doResolve({ action: "quit", exitCode: 0 }), 0);
      }
    },
    onRunEvent: (change, entry) => {
      runEvents.push({ change, entry });
    },
    waitForExit: () => exitPromise,
    requestQuit: () => doResolve({ action: "quit", exitCode: 0 }),
    requestRawSwitch: () => doResolve({ action: "raw-switch", exitCode: 0 }),
    unmount: (info) => doResolve(info ?? { action: "quit", exitCode: 0 }),
    setInFlight: () => undefined,
    snapshot: () => ({}) as BriefListState,
  };
  return {
    renderer,
    autorunEvents,
    runEvents,
    resolveExit: doResolve,
  };
}

async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-autorun-tui-cli-"));
  await mkdir(path.join(dir, "inputs"), { recursive: true });
  return dir;
}

async function freshStore(): Promise<SqliteRunStore> {
  const dbDir = await mkdtemp(path.join(tmpdir(), "minifac-autorun-tui-db-"));
  return SqliteRunStore.open(path.join(dbDir, "runs.db"));
}

describe("runCli — autorun output mode selection", () => {
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env.MINIFAC_HOME;
    process.env.MINIFAC_HOME = "/tmp/minifac-home-autorun-tui-test";
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be unset
    if (savedHome === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = savedHome;
  });

  it("routes to the autorun TUI when stdout is a TTY and no flag is supplied", async () => {
    const repo = await makeFixtureRepo();
    const out = new BufferStream({ isTTY: true });
    const err = new BufferStream();
    const fake = makeFakeAutorunRenderer();
    const code = await runCli(["autorun", "--once", "--watch", path.join(repo, "inputs")], {
      stdout: out,
      stderr: err,
      runCwd: repo,
      createAutorunTuiRenderer: () => fake.renderer,
      openRunStore: async () => freshStore(),
    });
    expect(code).toBe(0);
    // Renderer received at least the startup or poll-start event.
    expect(fake.autorunEvents.length).toBeGreaterThan(0);
    // Human logger NOT called: no `poll-start briefs=` line on stdout.
    expect(out.text()).not.toMatch(/poll-start briefs=/);
  });

  it("routes to raw output when stdout is not a TTY and no flag is supplied", async () => {
    const repo = await makeFixtureRepo();
    const out = new BufferStream({ isTTY: false });
    const err = new BufferStream();
    let rendererBuilt = false;
    const code = await runCli(["autorun", "--once", "--watch", path.join(repo, "inputs")], {
      stdout: out,
      stderr: err,
      runCwd: repo,
      createAutorunTuiRenderer: () => {
        rendererBuilt = true;
        return makeFakeAutorunRenderer().renderer;
      },
      openRunStore: async () => freshStore(),
    });
    expect(code).toBe(0);
    expect(rendererBuilt).toBe(false);
    expect(out.text()).toMatch(/poll-start briefs=/);
  });

  it("--raw forces raw output in a TTY", async () => {
    const repo = await makeFixtureRepo();
    const out = new BufferStream({ isTTY: true });
    const err = new BufferStream();
    let rendererBuilt = false;
    const code = await runCli(
      ["autorun", "--once", "--raw", "--watch", path.join(repo, "inputs")],
      {
        stdout: out,
        stderr: err,
        runCwd: repo,
        createAutorunTuiRenderer: () => {
          rendererBuilt = true;
          return makeFakeAutorunRenderer().renderer;
        },
        openRunStore: async () => freshStore(),
      },
    );
    expect(code).toBe(0);
    expect(rendererBuilt).toBe(false);
    expect(out.text()).toMatch(/poll-start briefs=/);
  });

  it("--tui forces the TUI in a non-TTY", async () => {
    const repo = await makeFixtureRepo();
    const out = new BufferStream({ isTTY: false });
    const err = new BufferStream();
    const fake = makeFakeAutorunRenderer();
    const code = await runCli(
      ["autorun", "--once", "--tui", "--watch", path.join(repo, "inputs")],
      {
        stdout: out,
        stderr: err,
        runCwd: repo,
        createAutorunTuiRenderer: () => fake.renderer,
        openRunStore: async () => freshStore(),
      },
    );
    expect(code).toBe(0);
    expect(fake.autorunEvents.length).toBeGreaterThan(0);
    expect(out.text()).not.toMatch(/poll-start briefs=/);
  });

  it("--raw --tui together exits 1 with the flag-conflict message", async () => {
    const repo = await makeFixtureRepo();
    const out = new BufferStream({ isTTY: true });
    const err = new BufferStream();
    let rendererBuilt = false;
    const code = await runCli(["autorun", "--raw", "--tui", "--watch", path.join(repo, "inputs")], {
      stdout: out,
      stderr: err,
      runCwd: repo,
      createAutorunTuiRenderer: () => {
        rendererBuilt = true;
        return makeFakeAutorunRenderer().renderer;
      },
      openRunStore: async () => freshStore(),
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--raw and --tui are mutually exclusive/);
    expect(rendererBuilt).toBe(false);
    expect(out.text()).not.toMatch(/poll-start/);
  });

  it("--tui --json together exits 1 with the flag-conflict message", async () => {
    const repo = await makeFixtureRepo();
    const out = new BufferStream({ isTTY: false });
    const err = new BufferStream();
    let rendererBuilt = false;
    const code = await runCli(
      ["autorun", "--tui", "--json", "--watch", path.join(repo, "inputs")],
      {
        stdout: out,
        stderr: err,
        runCwd: repo,
        createAutorunTuiRenderer: () => {
          rendererBuilt = true;
          return makeFakeAutorunRenderer().renderer;
        },
        openRunStore: async () => freshStore(),
      },
    );
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--tui and --json are mutually exclusive/);
    expect(rendererBuilt).toBe(false);
  });

  it("--json on a TTY without --tui keeps emitting JSON (no TUI mounted)", async () => {
    const repo = await makeFixtureRepo();
    const out = new BufferStream({ isTTY: true });
    const err = new BufferStream();
    let rendererBuilt = false;
    const code = await runCli(
      ["autorun", "--once", "--json", "--watch", path.join(repo, "inputs")],
      {
        stdout: out,
        stderr: err,
        runCwd: repo,
        createAutorunTuiRenderer: () => {
          rendererBuilt = true;
          return makeFakeAutorunRenderer().renderer;
        },
        openRunStore: async () => freshStore(),
      },
    );
    expect(code).toBe(0);
    expect(rendererBuilt).toBe(false);
    // JSON shape: each line parses as JSON.
    const lines = out
      .text()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Should not throw.
      JSON.parse(line);
    }
  });
});
