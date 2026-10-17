import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandExecutor } from "../executor/command.js";
import { ExecutorRegistry } from "../executor/registry.js";
import type {
  EmittedEvent,
  NodeEvent,
  NodeExecutor,
  NodeResult,
  ResolvedNode,
  RunContext,
} from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { Factory } from "../factory/schema.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import { resumeStateFromStore } from "./resume.js";
import { runFactory } from "./run.js";

// `when: on_error` edges and the node outcome (ADR 0052). These run the real
// runner; the executor answers from a per-dispatch script and records what
// it was handed.

const succeeded: NodeEvent = { kind: "status", status: "succeeded" };
/** A judged failure: the node ran and said no. */
const failed: NodeEvent = { kind: "status", status: "failed" };
/** An error: the executor could not produce a judgment (a crash). */
const crashed: NodeEvent = {
  kind: "status",
  status: "failed",
  meta: { exitCode: 137 },
  outcome: "error",
};

type Script = (nodeId: string, iteration: number) => NodeEvent[];

class ScriptedExecutor implements NodeExecutor {
  readonly type = "fake";
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  readonly supportsResume = false;
  dispatches: Array<{ nodeId: string; iteration: number; prior: readonly NodeResult[] }> = [];

  constructor(private readonly script: Script) {}

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    this.dispatches.push({ nodeId: node.id, iteration: ctx.iteration, prior: ctx.priorResults });
    for (const evt of this.script(node.id, ctx.iteration)) yield evt;
  }

  ids(): string[] {
    return this.dispatches.map((d) => d.nodeId);
  }
}

function wrap(factory: Factory): LoadedFactory {
  return { factory, sourcePath: "/tmp/factories/f.yaml", sourceDir: "/tmp/factories" };
}

function registryWith(...executors: NodeExecutor[]): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  for (const e of executors) registry.register(e);
  return registry;
}

/** `a` with an on_error edge to `e` and an on_failure edge to `r`. */
function both(aNode: Factory["nodes"][string] = { executor: "fake" }): Factory {
  return {
    name: "both",
    nodes: {
      a: aNode,
      e: { executor: "fake", terminal: true },
      r: { executor: "fake", terminal: true },
      s: { executor: "fake", terminal: true },
    },
    edges: [
      { from: "a", to: "s", when: "on_success" },
      { from: "a", to: "e", when: "on_error" },
      { from: "a", to: "r", when: "on_failure" },
    ],
  };
}

/** Terminal status events delivered to `onEvent` for `nodeId`. */
function terminalStatuses(seen: EmittedEvent[], nodeId: string): NodeEvent[] {
  return seen
    .filter((s) => s.nodeId === nodeId)
    .map((s) => s.event)
    .filter((e) => e.kind === "status" && e.status !== "started");
}

describe("on_error edges (ADR 0052)", () => {
  let dir: string;
  let home: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-on-error-"));
    home = process.env.MINIFAC_HOME;
    process.env.MINIFAC_HOME = path.join(dir, "home");
  });

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (home === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = home;
    await rm(dir, { recursive: true, force: true });
  });

  it("a crash takes the on_error edge, not the on_failure edge, and every record says error", async () => {
    const exec = new ScriptedExecutor((id) => (id === "a" ? [crashed] : [succeeded]));
    const seen: EmittedEvent[] = [];
    const result = await runFactory(wrap(both()), {
      registry: registryWith(exec),
      onEvent: (e) => seen.push(e),
    });
    expect(exec.ids()).toEqual(["a", "e"]);
    expect(result).toMatchObject({
      status: "succeeded",
      reason: "terminal_node_succeeded",
      proximateNodeId: "e",
    });
    // RunResult.log
    expect(result.log.map((l) => [l.nodeId, l.status, l.outcome])).toEqual([
      ["a", "failed", "error"],
      ["e", "succeeded", "success"],
    ]);
    // priorResults handed to the next node
    const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
    expect(priorA).toMatchObject({ status: "failed", outcome: "error" });
    // the event stream
    expect(terminalStatuses(seen, "a")).toEqual([{ ...crashed, outcome: "error" }]);
    expect(terminalStatuses(seen, "e")).toEqual([{ ...succeeded, outcome: "success" }]);
  });

  it("a crash with no on_error edge takes on_failure, as before", async () => {
    const { e: _unreachable, ...nodes } = both().nodes;
    // `e` goes with its edge: without one it would be a start node.
    const factory: Factory = {
      ...both(),
      nodes,
      edges: both().edges.filter((e) => e.when !== "on_error"),
    };
    const exec = new ScriptedExecutor((id) => (id === "a" ? [crashed] : [succeeded]));
    const result = await runFactory(wrap(factory), { registry: registryWith(exec) });
    expect(exec.ids()).toEqual(["a", "r"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", status: "failed", outcome: "error" });
    expect(result.reason).toBe("terminal_node_succeeded");
  });

  it("a crash with no outbound failure edge of either kind ends the run node_failed", async () => {
    const factory: Factory = {
      name: "alone",
      nodes: { a: { executor: "fake" }, s: { executor: "fake", terminal: true } },
      edges: [{ from: "a", to: "s", when: "on_success" }],
    };
    const exec = new ScriptedExecutor(() => [crashed]);
    const result = await runFactory(wrap(factory), { registry: registryWith(exec) });
    expect(exec.ids()).toEqual(["a"]);
    expect(result).toMatchObject({ status: "failed", reason: "node_failed", proximateNodeId: "a" });
    expect(result.log).toEqual([expect.objectContaining({ nodeId: "a", outcome: "error" })]);
  });

  it("a judged failure takes only on_failure, even when the node declares on_error", async () => {
    const exec = new ScriptedExecutor((id) => (id === "a" ? [failed] : [succeeded]));
    const seen: EmittedEvent[] = [];
    const result = await runFactory(wrap(both()), {
      registry: registryWith(exec),
      onEvent: (e) => seen.push(e),
    });
    expect(exec.ids()).toEqual(["a", "r"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", outcome: "failure" });
    expect(terminalStatuses(seen, "a")).toEqual([{ ...failed, outcome: "failure" }]);
  });

  it("a success never takes on_error", async () => {
    const exec = new ScriptedExecutor(() => [succeeded]);
    const result = await runFactory(wrap(both()), { registry: registryWith(exec) });
    expect(exec.ids()).toEqual(["a", "s"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", outcome: "success" });
  });

  it("a stream that ends with no terminal status is an error", async () => {
    const exec = new ScriptedExecutor((id) => (id === "a" ? [] : [succeeded]));
    const result = await runFactory(wrap(both()), { registry: registryWith(exec) });
    expect(exec.ids()).toEqual(["a", "e"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", status: "failed", outcome: "error" });
  });

  it("missing_required_output after a claimed success is an error, and the records agree", async () => {
    const factory = both({
      executor: "fake",
      outputs: { verdict: { type: "value", required: true } },
    });
    const exec = new ScriptedExecutor(() => [succeeded]);
    const seen: EmittedEvent[] = [];
    const result = await runFactory(wrap(factory), {
      registry: registryWith(exec),
      onEvent: (e) => seen.push(e),
    });
    expect(exec.ids()).toEqual(["a", "e"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", status: "failed", outcome: "error" });
    const statuses = terminalStatuses(seen, "a");
    // The executor's claimed success, then the runner's override.
    expect(statuses.map((e) => e.kind === "status" && [e.status, e.outcome])).toEqual([
      ["succeeded", "success"],
      ["failed", "error"],
    ]);
    const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
    expect(priorA).toMatchObject({ reason: "missing_required_output", outcome: "error" });
  });

  it("a pre-spawn resume failure is an error", async () => {
    const factory = both({ executor: "fake", resume: "s" });
    const exec = new ScriptedExecutor(() => [succeeded]);
    const seen: EmittedEvent[] = [];
    const result = await runFactory(wrap(factory), {
      registry: registryWith(exec),
      onEvent: (e) => seen.push(e),
    });
    // `a` never reached the executor; its on_error edge did.
    expect(exec.ids()).toEqual(["e"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", outcome: "error" });
    expect(terminalStatuses(seen, "a")).toEqual([
      expect.objectContaining({ status: "failed", outcome: "error" }),
    ]);
  });

  it("a real command executor timeout routes on_error", async () => {
    const factory: Factory = {
      name: "timeout",
      nodes: {
        a: {
          executor: "command",
          with: { commands: [{ id: "slow", run: "sleep 5", timeout_seconds: 1 }] },
        },
        e: { executor: "fake", terminal: true },
        r: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "a", to: "e", when: "on_error" },
        { from: "a", to: "r", when: "on_failure" },
      ],
    };
    const exec = new ScriptedExecutor(() => [succeeded]);
    const result = await runFactory(
      { ...wrap(factory), sourceDir: dir },
      { registry: registryWith(exec, new CommandExecutor({ killGraceMs: 200 })), runCwd: dir },
    );
    expect(exec.ids()).toEqual(["e"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", status: "failed", outcome: "error" });
  });

  it("a real command exiting outside expect.exit is a judged failure and routes on_failure", async () => {
    const factory: Factory = {
      name: "red",
      nodes: {
        a: { executor: "command", with: { commands: [{ id: "gate", run: "exit 1" }] } },
        e: { executor: "fake", terminal: true },
        r: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "a", to: "e", when: "on_error" },
        { from: "a", to: "r", when: "on_failure" },
      ],
    };
    const exec = new ScriptedExecutor(() => [succeeded]);
    const result = await runFactory(
      { ...wrap(factory), sourceDir: dir },
      { registry: registryWith(exec, new CommandExecutor({ killGraceMs: 200 })), runCwd: dir },
    );
    expect(exec.ids()).toEqual(["r"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", outcome: "failure" });
  });

  describe("budgets", () => {
    /** `a` retries itself on error at most twice, and succeeds into `done`. */
    const retry: Factory = {
      name: "retry",
      nodes: { a: { executor: "fake" }, done: { executor: "fake", terminal: true } },
      edges: [
        { from: "a", to: "done", when: "on_success" },
        { from: "a", to: "a", when: "on_error", max_traversals: 2 },
      ],
    };

    it("an on_error self-loop with max_traversals 2 dispatches 3 times, then budget_exhausted", async () => {
      const exec = new ScriptedExecutor(() => [crashed]);
      const result = await runFactory(wrap(retry), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual(["a", "a", "a"]);
      expect(result).toMatchObject({
        status: "failed",
        reason: "budget_exhausted",
        proximateNodeId: "a",
      });
    });

    it("the on_error traversal is counted under the `a->a:on_error` key", async () => {
      const exec = new ScriptedExecutor(() => [crashed]);
      // Park before the third dispatch to read the traversal counts.
      const result = await runFactory(wrap(retry), {
        registry: registryWith(exec),
        onNodeBoundary: (b) => (b.iteration === 3 ? "park" : "continue"),
      });
      expect(result.status).toBe("parked");
      expect(result.parked?.edgeTraversals).toEqual({ "a->a:on_error": 2 });
      expect(result.parked?.via).toBe("a->a:on_error");
    });

    it("an exhausted on_error edge ends the run; it does not fall back to on_failure", async () => {
      const factory: Factory = {
        name: "no-fallthrough",
        nodes: {
          a: { executor: "fake" },
          r: { executor: "fake", terminal: true },
          done: { executor: "fake", terminal: true },
        },
        edges: [
          { from: "a", to: "done", when: "on_success" },
          { from: "a", to: "a", when: "on_error", max_traversals: 1 },
          { from: "a", to: "r", when: "on_failure" },
        ],
      };
      const exec = new ScriptedExecutor(() => [crashed]);
      const result = await runFactory(wrap(factory), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual(["a", "a"]);
      expect(result).toMatchObject({ status: "failed", reason: "budget_exhausted" });
    });
  });

  describe("runs.db", () => {
    it("recordNodeEnd stores the outcome, and a resume rebuilds NodeResult.outcome from it", async () => {
      const store = SqliteRunStore.open(path.join(dir, "runs.db"));
      try {
        const exec = new ScriptedExecutor((id) => (id === "a" ? [crashed] : [succeeded]));
        const runId = "run-on-error";
        await runFactory(wrap(both()), { registry: registryWith(exec), store, runId });
        const rows = await store.getNodeExecutions(runId);
        expect(rows.map((r) => [r.nodeId, r.status, r.outcome])).toEqual([
          ["a", "failed", "error"],
          ["e", "succeeded", "success"],
        ]);
        // The persisted status event carries the outcome too.
        const events = await store.getRunEvents(runId, { kind: "status" });
        expect(events.find((e) => e.nodeId === "a")?.payload).toMatchObject({
          status: "failed",
          outcome: "error",
        });
        const state = await resumeStateFromStore({ store, runId, at: "a" });
        expect(state.priorResults.map((p) => [p.nodeId, p.outcome])).toEqual([
          ["a", "error"],
          ["e", "success"],
        ]);
      } finally {
        await store.close();
      }
    });
  });
});
