import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode, RunContext } from "../executor/types.js";
import { type LoadedFactory, loadFactory } from "../factory/loader.js";
import type { Factory } from "../factory/schema.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import { resumeStateFromStore } from "./resume.js";
import { runFactory } from "./run.js";

// `{{ node.iteration }}`, `{{ edge.traversals }}` and `{{ edge.max_traversals }}`
// (ADR 0050). These run the real runner; the executor only records what it
// was handed and answers from a per-dispatch script.

const succeeded: NodeEvent = { kind: "status", status: "succeeded" };
const failed: NodeEvent = { kind: "status", status: "failed" };

type Script = (nodeId: string, iteration: number) => NodeEvent[];

class RecordingExecutor implements NodeExecutor {
  readonly type = "fake";
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  readonly supportsResume = false;
  dispatches: Array<{ nodeId: string; iteration: number; prompt: string; cwd: string }> = [];

  constructor(private readonly script: Script = () => [succeeded]) {}

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    this.dispatches.push({
      nodeId: node.id,
      iteration: ctx.iteration,
      prompt: typeof node.with?.prompt === "string" ? node.with.prompt : "",
      cwd: ctx.cwd,
    });
    for (const evt of this.script(node.id, ctx.iteration)) yield evt;
  }

  promptsOf(nodeId: string): string[] {
    return this.dispatches.filter((d) => d.nodeId === nodeId).map((d) => d.prompt);
  }
}

function wrap(factory: Factory): LoadedFactory {
  return { factory, sourcePath: "/tmp/factories/f.yaml", sourceDir: "/tmp/factories" };
}

function registryWith(exec: RecordingExecutor): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(exec);
  return registry;
}

const TOKENS = "iter={{ node.iteration }} trav={{ edge.traversals }} max={{ edge.max_traversals }}";

/** Start node `work` → `check`; `check` fails back to `work` at most twice. */
const loop: Factory = {
  name: "loop",
  nodes: {
    work: { executor: "fake", start: true, with: { prompt: TOKENS } },
    check: { executor: "fake", with: { prompt: `check ${TOKENS}` } },
    done: { executor: "fake", terminal: true, with: { prompt: `done ${TOKENS}` } },
  },
  edges: [
    { from: "work", to: "check", when: "on_success" },
    { from: "check", to: "work", when: "on_failure", max_traversals: 2 },
    { from: "check", to: "done", when: "on_success" },
  ],
};

/** `check` fails its first two dispatches and succeeds on the third. */
const failTwice: Script = (nodeId, iteration) =>
  nodeId === "check" && iteration < 3 ? [failed] : [succeeded];

describe("node.iteration / edge.* tokens (ADR 0050)", () => {
  let dir: string;
  let home: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-iter-tokens-"));
    home = process.env.MINIFAC_HOME;
    process.env.MINIFAC_HOME = path.join(dir, "home");
  });

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (home === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = home;
    await rm(dir, { recursive: true, force: true });
  });

  // TS-4 / AC-1, AC-2, AC-3, AC-4
  it("a three-pass loop renders iterations 1..3 and traversals 0..2", async () => {
    const exec = new RecordingExecutor(failTwice);
    const result = await runFactory(wrap(loop), { registry: registryWith(exec) });

    expect(result.status).toBe("succeeded");
    expect(exec.promptsOf("work")).toEqual([
      "iter=1 trav=0 max=",
      "iter=2 trav=1 max=2",
      "iter=3 trav=2 max=2",
    ]);
    // `node.iteration` is the dispatch's own iteration (RunContext.iteration).
    expect(exec.dispatches.filter((d) => d.nodeId === "work").map((d) => d.iteration)).toEqual([
      1, 2, 3,
    ]);
    // `check` is entered by a budget-less edge each time.
    expect(exec.promptsOf("check")).toEqual([
      "check iter=1 trav=1 max=",
      "check iter=2 trav=2 max=",
      "check iter=3 trav=3 max=",
    ]);
    expect(exec.promptsOf("done")).toEqual(["done iter=1 trav=1 max="]);
  });

  // TS-5 / AC-2, AC-3
  it("a start node renders traversals 0 and an empty budget; its successor traversals 1", async () => {
    const linear: Factory = {
      name: "linear",
      nodes: {
        A: { executor: "fake", with: { prompt: TOKENS } },
        B: { executor: "fake", terminal: true, with: { prompt: TOKENS } },
      },
      edges: [{ from: "A", to: "B", when: "on_success" }],
    };
    const exec = new RecordingExecutor();
    await runFactory(wrap(linear), { registry: registryWith(exec) });
    expect(exec.promptsOf("A")).toEqual(["iter=1 trav=0 max="]);
    expect(exec.promptsOf("B")).toEqual(["iter=1 trav=1 max="]);
  });

  // TS-6 / AC-6
  it("a pause resume renders the counts the parked dispatch would have had", async () => {
    const store = SqliteRunStore.open(path.join(dir, "runs.db"));
    try {
      const first = new RecordingExecutor(failTwice);
      const parked = await runFactory(wrap(loop), {
        registry: registryWith(first),
        store,
        runId: "run-pause",
        onNodeBoundary: (b) => (b.nodeId === "work" && b.iteration === 3 ? "park" : "continue"),
      });
      expect(parked.status).toBe("parked");
      expect(first.promptsOf("work")).toEqual(["iter=1 trav=0 max=", "iter=2 trav=1 max=2"]);
      expect(parked.parked?.via).toBe("check->work:on_failure");
      expect(parked.parked?.pending).toEqual([
        { nodeId: "work", iteration: 3, via: "check->work:on_failure" },
      ]);

      const state = await resumeStateFromStore({ store, runId: "run-pause", at: "work" });
      const second = new RecordingExecutor(failTwice);
      const resumed = await runFactory(wrap(loop), {
        registry: registryWith(second),
        store,
        runId: "run-pause",
        resume: {
          ...state,
          reason: "pause",
          edgeTraversals: parked.parked?.edgeTraversals ?? {},
          ...(parked.parked?.via !== undefined ? { via: parked.parked.via } : {}),
        },
      });
      expect(resumed.status).toBe("succeeded");
      expect(second.promptsOf("work")).toEqual(["iter=3 trav=2 max=2"]);
    } finally {
      await store.close();
    }
  });

  // AC-6 control: a `via` that names no edge into the seed is ignored.
  it("a pause resume ignores a via that names no declared edge into the seed", async () => {
    for (const via of ["nowhere->work:on_failure", "work->check:on_success"]) {
      const exec = new RecordingExecutor();
      await runFactory(wrap(loop), {
        registry: registryWith(exec),
        resume: {
          at: "work",
          priorResults: [],
          iterations: { work: 2, check: 2 },
          edgeTraversals: { "check->work:on_failure": 2, "work->check:on_success": 2 },
          reason: "pause",
          via,
        },
      });
      expect(exec.promptsOf("work")[0]).toBe("iter=3 trav=0 max=");
    }
  });

  // TS-7 / AC-7
  it("an answer resume-at-node renders iteration n+1 and, with no via, traversals 0", async () => {
    const store = SqliteRunStore.open(path.join(dir, "runs.db"));
    try {
      // work#1, check#1 (fail), work#2, check#2 (fail), then park before work#3.
      await runFactory(wrap(loop), {
        registry: registryWith(new RecordingExecutor(failTwice)),
        store,
        runId: "run-answer",
        onNodeBoundary: (b) => (b.nodeId === "work" && b.iteration === 3 ? "park" : "continue"),
      });
      const state = await resumeStateFromStore({ store, runId: "run-answer", at: "work" });
      expect(state.via).toBeUndefined();
      const exec = new RecordingExecutor(failTwice);
      await runFactory(wrap(loop), {
        registry: registryWith(exec),
        resume: { ...state, feedback: "go on" },
      });
      expect(exec.promptsOf("work")[0]?.startsWith("iter=3 trav=0 max=")).toBe(true);
    } finally {
      await store.close();
    }
  });

  // TS-8 / AC-5
  it("renders through a uses: node's inputs binding and in cwd", async () => {
    await mkdir(path.join(dir, "examples", "steps"), { recursive: true });
    await writeFile(
      path.join(dir, "examples", "steps", "counted.yaml"),
      `name: counted
version: "1"
executor: fake
inputs:
  pass: { type: string, required: true }
with:
  prompt: "pass {{ inputs.pass }}"
`,
      "utf8",
    );
    const facPath = path.join(dir, "fac.yaml");
    await writeFile(
      facPath,
      `name: f
nodes:
  work:
    uses: minifac:counted
    start: true
    cwd: "{{ run.cwd }}/i{{ node.iteration }}"
    inputs:
      pass: "{{ node.iteration }} of edge {{ edge.traversals }}/{{ edge.max_traversals }}"
  check:
    executor: fake
    with: { prompt: check }
  done:
    executor: fake
    terminal: true
    with: { prompt: done }
edges:
  - { from: work, to: check, when: on_success }
  - { from: check, to: work, when: on_failure, max_traversals: 2 }
  - { from: check, to: done, when: on_success }
`,
      "utf8",
    );
    const loaded = await loadFactory(facPath, dir);
    // Load-time inlining leaves the dispatch-time tokens alone.
    expect(loaded.factory.nodes.work?.with?.prompt).toBe(
      "pass {{ node.iteration }} of edge {{ edge.traversals }}/{{ edge.max_traversals }}",
    );

    const exec = new RecordingExecutor(failTwice);
    const result = await runFactory(loaded, { registry: registryWith(exec), runCwd: dir });
    expect(result.status).toBe("succeeded");
    expect(exec.promptsOf("work")).toEqual([
      "pass 1 of edge 0/",
      "pass 2 of edge 1/2",
      "pass 3 of edge 2/2",
    ]);
    expect(exec.dispatches.filter((d) => d.nodeId === "work").map((d) => d.cwd)).toEqual([
      `${dir}/i1`,
      `${dir}/i2`,
      `${dir}/i3`,
    ]);
  });

  // TS-9 / AC-8
  it("an unknown node.* or edge.* field reaches the executor verbatim", async () => {
    const unknown: Factory = {
      name: "unknown",
      nodes: {
        A: {
          executor: "fake",
          terminal: true,
          with: { prompt: "{{ node.foo }} {{ edge.bar }} {{ node.iteration.x }}" },
        },
      },
      edges: [],
    };
    const exec = new RecordingExecutor();
    const result = await runFactory(wrap(unknown), { registry: registryWith(exec) });
    expect(result.status).toBe("succeeded");
    expect(exec.promptsOf("A")).toEqual(["{{ node.foo }} {{ edge.bar }} {{ node.iteration.x }}"]);
  });
});
