import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../executor/registry.js";
import type {
  EmittedEvent,
  NodeEvent,
  NodeExecutor,
  ResolvedNode,
  RunContext,
} from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { Factory } from "../factory/schema.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import type { RunResult } from "./result.js";
import { HUMAN_ANSWER_HEADING, type ResumeState, resumeStateFromStore } from "./resume.js";
import { type NodeBoundary, type NodeBoundaryDecision, runFactory } from "./run.js";

// The between-node boundary hook and the pause resume (ADR 0048). These run
// the real runner against a real SQLite run store, so the park → store →
// `resumeStateFromStore` → pause-resume round trip is the one a caller makes.

const succeeded: NodeEvent = { kind: "status", status: "succeeded" };
const failed: NodeEvent = { kind: "status", status: "failed" };

class RecordingExecutor implements NodeExecutor {
  readonly type = "fake";
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  readonly supportsResume = false;
  dispatches: Array<{ nodeId: string; iteration: number; prompt: string }> = [];

  constructor(private readonly scripts: Record<string, NodeEvent[]> = {}) {}

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    this.dispatches.push({
      nodeId: node.id,
      iteration: ctx.iteration,
      prompt: typeof node.with?.prompt === "string" ? node.with.prompt : "",
    });
    for (const evt of this.scripts[node.id] ?? [succeeded]) yield evt;
  }

  order(): string[] {
    return this.dispatches.map((d) => `${d.nodeId}#${d.iteration}`);
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

/** A hook that records every boundary and answers from `decide`. */
function recordingHook(
  decide: (b: NodeBoundary) => NodeBoundaryDecision | Promise<NodeBoundaryDecision> = () =>
    "continue",
) {
  const calls: NodeBoundary[] = [];
  const hook = (b: NodeBoundary) => {
    calls.push(b);
    return decide(b);
  };
  return { calls, hook };
}

/** The result without its timing, for comparing two runs. */
function shape(result: RunResult): unknown {
  const { durationMs: _d, log, ...rest } = result;
  return { ...rest, log: log.map(({ startedAt: _s, endedAt: _e, ...entry }) => entry) };
}

const linear: Factory = {
  name: "linear",
  nodes: {
    A: { executor: "fake" },
    B: { executor: "fake" },
    C: { executor: "fake", terminal: true },
  },
  edges: [
    { from: "A", to: "B", when: "on_success" },
    { from: "B", to: "C", when: "on_success" },
  ],
};

describe("runFactory onNodeBoundary (ADR 0048)", () => {
  let dir: string;
  let home: string | undefined;
  let store: SqliteRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-park-"));
    home = process.env.MINIFAC_HOME;
    process.env.MINIFAC_HOME = path.join(dir, "home");
    store = SqliteRunStore.open(path.join(dir, "runs.db"));
  });

  afterEach(async () => {
    await store.close();
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (home === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = home;
    await rm(dir, { recursive: true, force: true });
  });

  // TS-1 / AC-1, AC-2
  it("parks before the next node without dispatching it, and the store row says parked", async () => {
    const exec = new RecordingExecutor();
    const { calls, hook } = recordingHook((b) => (b.nodeId === "B" ? "park" : "continue"));
    const events: EmittedEvent[] = [];

    const result = await runFactory(wrap(linear), {
      registry: registryWith(exec),
      store,
      runId: "run-park",
      onNodeBoundary: hook,
      onEvent: (e) => events.push(e),
    });

    expect(exec.order()).toEqual(["A#1"]);
    expect(calls).toEqual([
      { nodeId: "A", iteration: 1, first: true },
      { nodeId: "B", iteration: 1, first: false },
    ]);
    expect(result.status).toBe("parked");
    expect(result.reason).toBe("parked");
    expect(result.proximateNodeId).toBe("B");
    expect(result.parked).toEqual({
      nodeId: "B",
      iteration: 1,
      pending: [{ nodeId: "B", iteration: 1 }],
      edgeTraversals: { "A->B:on_success": 1 },
    });

    const row = await store.getRun("run-park");
    expect(row?.status).toBe("parked");
    expect(row?.reason).toBe("parked");
    expect(row?.proximateNodeId).toBe("B");
    // No node execution was started for the parked node.
    const executions = await store.getNodeExecutions("run-park");
    expect(executions.map((e) => `${e.nodeId}#${e.iteration}`)).toEqual(["A#1"]);
    // The park is visible in the event stream and the store.
    expect(
      events.some(
        (e) => e.event.kind === "runner-action" && /parked before node "B"/.test(e.event.line),
      ),
    ).toBe(true);
    const stored = await store.getRunEvents("run-park", { kind: "runner-action" });
    expect(stored.some((e) => e.nodeId === "B")).toBe(true);
  });

  // TS-4 / AC-1, AC-2
  it("parks before the run's first dispatch", async () => {
    const exec = new RecordingExecutor();
    const result = await runFactory(wrap(linear), {
      registry: registryWith(exec),
      onNodeBoundary: () => "park",
    });

    expect(exec.dispatches).toEqual([]);
    expect(result.status).toBe("parked");
    expect(result.parked).toMatchObject({ nodeId: "A", iteration: 1, edgeTraversals: {} });
  });

  // TS-2 / AC-5
  it("with no hook, or a hook that always continues, runs exactly as before", async () => {
    const baselineExec = new RecordingExecutor();
    const baseline = await runFactory(wrap(linear), { registry: registryWith(baselineExec) });

    const continueExec = new RecordingExecutor();
    const { calls, hook } = recordingHook();
    const withHook = await runFactory(wrap(linear), {
      registry: registryWith(continueExec),
      onNodeBoundary: hook,
    });

    expect(baselineExec.order()).toEqual(["A#1", "B#1", "C#1"]);
    expect(continueExec.order()).toEqual(baselineExec.order());
    expect(shape(withHook)).toEqual(shape(baseline));
    expect(baseline.status).toBe("succeeded");
    expect(baseline.parked).toBeUndefined();
    expect(calls.map((c) => c.nodeId)).toEqual(["A", "B", "C"]);
  });

  // TS-3 / AC-4
  describe("fails open", () => {
    const cases: Array<[string, () => NodeBoundaryDecision | Promise<NodeBoundaryDecision>]> = [
      [
        "throws",
        () => {
          throw new Error("boom sync");
        },
      ],
      ["rejects", () => Promise.reject(new Error("boom async"))],
      ["never resolves", () => new Promise<NodeBoundaryDecision>(() => {})],
    ];

    for (const [label, impl] of cases) {
      it(`when the hook ${label}: every node runs and the failure is in the event stream`, async () => {
        const exec = new RecordingExecutor();
        const { calls, hook } = recordingHook(impl);
        const events: EmittedEvent[] = [];

        const result = await runFactory(wrap(linear), {
          registry: registryWith(exec),
          store,
          runId: `run-${label.replace(/\s/g, "-")}`,
          onNodeBoundary: hook,
          nodeBoundaryTimeoutMs: 20,
          onEvent: (e) => events.push(e),
        });

        expect(result.status).toBe("succeeded");
        expect(result.reason).toBe("terminal_node_succeeded");
        expect(exec.order()).toEqual(["A#1", "B#1", "C#1"]);
        // Consulted again at every later boundary.
        expect(calls.map((c) => c.nodeId)).toEqual(["A", "B", "C"]);
        const failures = events.filter(
          (e) => e.event.kind === "stderr" && e.event.line.includes("node boundary hook failed"),
        );
        expect(failures).toHaveLength(3);
        const stored = await store.getRunEvents(`run-${label.replace(/\s/g, "-")}`, {
          kind: "stderr",
        });
        expect(
          stored.filter((e) => JSON.stringify(e.payload).includes("node boundary hook failed")),
        ).toHaveLength(3);
      });
    }

    it("names the timeout", async () => {
      const events: EmittedEvent[] = [];
      await runFactory(wrap(linear), {
        registry: registryWith(new RecordingExecutor()),
        onNodeBoundary: () => new Promise<NodeBoundaryDecision>(() => {}),
        nodeBoundaryTimeoutMs: 20,
        onEvent: (e) => events.push(e),
      });
      const first = events.find((e) => e.event.kind === "stderr");
      expect(first?.event.kind === "stderr" && first.event.line).toContain("timed out after 20 ms");
    });
  });

  // TS-5 / AC-6
  it("is not called after a terminal node succeeds or after an unrecovered failure", async () => {
    const twoNode: Factory = {
      name: "two",
      nodes: { A: { executor: "fake" }, B: { executor: "fake", terminal: true } },
      edges: [{ from: "A", to: "B", when: "on_success" }],
    };
    const ok = recordingHook();
    const okResult = await runFactory(wrap(twoNode), {
      registry: registryWith(new RecordingExecutor()),
      onNodeBoundary: ok.hook,
    });
    expect(okResult.reason).toBe("terminal_node_succeeded");
    expect(ok.calls.map((c) => c.nodeId)).toEqual(["A", "B"]);

    const bad = recordingHook();
    const badResult = await runFactory(wrap(twoNode), {
      registry: registryWith(new RecordingExecutor({ A: [failed] })),
      onNodeBoundary: bad.hook,
    });
    expect(badResult.status).toBe("failed");
    expect(badResult.reason).toBe("node_failed");
    expect(bad.calls.map((c) => c.nodeId)).toEqual(["A"]);
  });

  // TS-6 / AC-7
  it("does not consult the hook while more than one dispatch is pending", async () => {
    const fanOut: Factory = {
      name: "fan",
      nodes: {
        A: { executor: "fake" },
        B: { executor: "fake" },
        C: { executor: "fake" },
        D: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "A", to: "B", when: "on_success" },
        { from: "A", to: "C", when: "on_success" },
        { from: "C", to: "D", when: "on_success" },
      ],
    };
    const exec = new RecordingExecutor();
    // Parks at every boundary it is asked about, except the first.
    const { calls, hook } = recordingHook((b) => (b.first ? "continue" : "park"));

    const result = await runFactory(wrap(fanOut), {
      registry: registryWith(exec),
      onNodeBoundary: hook,
    });

    // B was popped with C still pending: not consulted, dispatched. C was
    // the next single-pending boundary, and the run parked there.
    expect(calls.map((c) => c.nodeId)).toEqual(["A", "C"]);
    expect(exec.order()).toEqual(["A#1", "B#1"]);
    expect(result.status).toBe("parked");
    expect(result.parked?.nodeId).toBe("C");
    expect(result.parked?.pending).toEqual([{ nodeId: "C", iteration: 1 }]);
  });

  // TS-7 / AC-8
  it("a pause resume after a park runs the remaining nodes once each", async () => {
    const first = new RecordingExecutor();
    const parked = await runFactory(wrap(linear), {
      registry: registryWith(first),
      store,
      runId: "run-trip",
      onNodeBoundary: (b) => (b.nodeId === "B" ? "park" : "continue"),
    });
    expect(parked.status).toBe("parked");
    const at = parked.parked?.nodeId ?? "";

    // The state a caller rebuilds from the store, plus the pause fields.
    const state = await resumeStateFromStore({ store, runId: "run-trip", at });
    const resume: ResumeState = {
      ...state,
      reason: "pause",
      edgeTraversals: parked.parked?.edgeTraversals ?? {},
    };

    const second = new RecordingExecutor();
    const { calls, hook } = recordingHook();
    const resumed = await runFactory(wrap(linear), {
      registry: registryWith(second),
      store,
      runId: "run-trip",
      resume,
      onNodeBoundary: hook,
    });

    expect(first.order()).toEqual(["A#1"]);
    expect(second.order()).toEqual(["B#1", "C#1"]);
    expect(calls[0]).toEqual({ nodeId: "B", iteration: 1, first: true });
    expect(resumed.status).toBe("succeeded");
    expect((await store.getRun("run-trip"))?.status).toBe("succeeded");
  });

  // TS-8 / AC-10
  describe("edge budgets survive a park and resume", () => {
    const reviseLoop: Factory = {
      name: "revise",
      nodes: {
        implement: { executor: "fake", start: true },
        review: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "implement", to: "review", when: "on_success" },
        { from: "review", to: "implement", when: "on_failure", max_traversals: 1 },
      ],
    };
    const scripts = { review: [failed] };

    async function parkAtSecondImplement(runId: string) {
      const exec = new RecordingExecutor(scripts);
      const parked = await runFactory(wrap(reviseLoop), {
        registry: registryWith(exec),
        store,
        runId,
        onNodeBoundary: (b) =>
          b.nodeId === "implement" && b.iteration === 2 ? "park" : "continue",
      });
      expect(exec.order()).toEqual(["implement#1", "review#1"]);
      expect(parked.parked).toEqual({
        nodeId: "implement",
        iteration: 2,
        pending: [{ nodeId: "implement", iteration: 2 }],
        edgeTraversals: { "implement->review:on_success": 1, "review->implement:on_failure": 1 },
      });
      const state = await resumeStateFromStore({ store, runId, at: "implement" });
      return { parked, state };
    }

    it("takes the same path as an uninterrupted run", async () => {
      const straight = new RecordingExecutor(scripts);
      const uninterrupted = await runFactory(wrap(reviseLoop), {
        registry: registryWith(straight),
      });

      const { parked, state } = await parkAtSecondImplement("run-budget");
      const after = new RecordingExecutor(scripts);
      const resumed = await runFactory(wrap(reviseLoop), {
        registry: registryWith(after),
        store,
        runId: "run-budget",
        resume: { ...state, reason: "pause", edgeTraversals: parked.parked?.edgeTraversals },
      });

      expect(straight.order()).toEqual(["implement#1", "review#1", "implement#2", "review#2"]);
      expect(["implement#1", "review#1", ...after.order()]).toEqual(straight.order());
      expect(resumed.status).toBe(uninterrupted.status);
      expect(resumed.reason).toBe(uninterrupted.reason);
      expect(resumed.reason).toBe("budget_exhausted");
    });

    it("without the carried counts the loop gets a fresh budget (control)", async () => {
      const { state } = await parkAtSecondImplement("run-control");
      const after = new RecordingExecutor(scripts);
      await runFactory(wrap(reviseLoop), {
        registry: registryWith(after),
        store,
        runId: "run-control",
        resume: { ...state, reason: "pause" },
      });
      // One more revise cycle than the uninterrupted run took.
      expect(after.order()).toEqual(["implement#2", "review#2", "implement#3", "review#3"]);
    });

    it("ignores negative counts and keys naming no declared edge", async () => {
      const { state } = await parkAtSecondImplement("run-junk");
      const after = new RecordingExecutor(scripts);
      const resumed = await runFactory(wrap(reviseLoop), {
        registry: registryWith(after),
        store,
        runId: "run-junk",
        resume: {
          ...state,
          reason: "pause",
          edgeTraversals: { "review->implement:on_failure": -1, "nowhere->else:on_success": 3 },
        },
        // Park again before the third implement, to read the counters back.
        onNodeBoundary: (b) => (b.iteration === 3 ? "park" : "continue"),
      });
      // A -1 taken at face value would have allowed a second traversal before
      // the counter reached the budget; ignored, it starts from 0.
      expect(after.order()).toEqual(["implement#2", "review#2"]);
      expect(resumed.parked?.edgeTraversals).toEqual({
        "implement->review:on_success": 1,
        "review->implement:on_failure": 1,
      });
    });
  });

  // TS-9 / AC-9
  describe("a pause resume grants no human-answer privileges", () => {
    const tokens: Factory = {
      name: "tokens",
      nodes: {
        evaluate: {
          executor: "fake",
          terminal: true,
          max_iterations: 1,
          with: {
            prompt: "resumed_at=[{{ run.resumed_at }}] feedback=[{{ run.feedback }}]",
          },
        },
      },
      edges: [],
    };

    it("renders the carried run scope and appends no answer block", async () => {
      const exec = new RecordingExecutor();
      await runFactory(wrap(tokens), {
        registry: registryWith(exec),
        resume: { at: "evaluate", priorResults: [], reason: "pause", feedback: "earlier answer" },
      });
      expect(exec.dispatches[0]?.prompt).toBe("resumed_at=[] feedback=[earlier answer]");
      expect(exec.dispatches[0]?.prompt).not.toContain(HUMAN_ANSWER_HEADING);

      const carried = new RecordingExecutor();
      await runFactory(wrap(tokens), {
        registry: registryWith(carried),
        resume: { at: "evaluate", priorResults: [], reason: "pause", resumedAt: "plan" },
      });
      expect(carried.dispatches[0]?.prompt).toBe("resumed_at=[plan] feedback=[]");
    });

    it("checks the seed against max_iterations, unlike an answer resume", async () => {
      // TS-10 / AC-1 too: the budget refuses the seed at the queue head, and
      // the hook is never asked about a dispatch that was not admitted.
      const exec = new RecordingExecutor();
      const { calls, hook } = recordingHook();
      const paused = await runFactory(wrap(tokens), {
        registry: registryWith(exec),
        resume: { at: "evaluate", priorResults: [], iterations: { evaluate: 1 }, reason: "pause" },
        onNodeBoundary: hook,
      });
      expect(exec.dispatches).toEqual([]);
      expect(calls).toEqual([]);
      expect(paused.reason).toBe("budget_exhausted");

      const answered = new RecordingExecutor();
      const answer = await runFactory(wrap(tokens), {
        registry: registryWith(answered),
        resume: { at: "evaluate", priorResults: [], iterations: { evaluate: 1 }, feedback: "yes" },
      });
      expect(answered.order()).toEqual(["evaluate#2"]);
      expect(answered.dispatches[0]?.prompt).toContain("resumed_at=[evaluate]");
      expect(answered.dispatches[0]?.prompt).toContain(HUMAN_ANSWER_HEADING);
      expect(answer.status).toBe("succeeded");
    });
  });

  // TS-11 / AC-3
  describe("abort is unchanged and separate from park", () => {
    it("an abort before the loop is user_quit with no node, and the hook is not called", async () => {
      const controller = new AbortController();
      controller.abort();
      const { calls, hook } = recordingHook(() => "park");
      const result = await runFactory(wrap(linear), {
        registry: registryWith(new RecordingExecutor()),
        abortSignal: controller.signal,
        onNodeBoundary: hook,
      });
      expect(result.status).toBe("failed");
      expect(result.reason).toBe("user_quit");
      expect(result.proximateNodeId).toBeUndefined();
      expect(result.parked).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it("an abort that lands while the hook runs dispatches nothing more", async () => {
      const controller = new AbortController();
      const exec = new RecordingExecutor();
      const result = await runFactory(wrap(linear), {
        registry: registryWith(exec),
        abortSignal: controller.signal,
        onNodeBoundary: (b) => {
          if (b.nodeId === "B") controller.abort();
          return "continue";
        },
      });
      expect(exec.order()).toEqual(["A#1"]);
      expect(result.reason).toBe("user_quit");
      expect(result.proximateNodeId).toBeUndefined();
    });

    it("a park leaves the caller's abortSignal untouched", async () => {
      const controller = new AbortController();
      const result = await runFactory(wrap(linear), {
        registry: registryWith(new RecordingExecutor()),
        abortSignal: controller.signal,
        onNodeBoundary: (b) => (b.nodeId === "B" ? "park" : "continue"),
      });
      expect(result.status).toBe("parked");
      expect(controller.signal.aborted).toBe(false);
    });
  });
});
