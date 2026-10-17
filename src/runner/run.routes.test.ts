import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { type LoadedFactory, loadFactory } from "../factory/loader.js";
import { synthesizeRouteOutputs } from "../factory/routes.js";
import type { Factory, FactoryEdge, FactoryNode } from "../factory/schema.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import { resumeStateFromStore } from "./resume.js";
import { runFactory } from "./run.js";

// Node-chosen routing at run time (ADR 0055, SCARIFW-2252). These run the
// real runner; the executor writes `next.json` (and `result.json`) into the
// node's outputs dir and then reports a terminal status.

const succeeded: NodeEvent = { kind: "status", status: "succeeded" };
const failed: NodeEvent = { kind: "status", status: "failed" };
const crashed: NodeEvent = {
  kind: "status",
  status: "failed",
  meta: { exitCode: 137 },
  outcome: "error",
};

interface Step {
  /** JSON written to `<outputsDir>/next.json`; undefined writes nothing. */
  next?: unknown;
  /** JSON written to `<outputsDir>/result.json`; undefined writes nothing. */
  result?: unknown;
  status: NodeEvent;
}

class WritingExecutor implements NodeExecutor {
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  readonly supportsResume = false;
  dispatches: Array<{
    nodeId: string;
    iteration: number;
    prompt: string;
    prior: RunContext["priorResults"];
  }> = [];

  constructor(
    private readonly script: (nodeId: string, iteration: number) => Step,
    readonly type = "fake",
  ) {}

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    this.dispatches.push({
      nodeId: node.id,
      iteration: ctx.iteration,
      prompt: typeof node.with?.prompt === "string" ? node.with.prompt : "",
      prior: ctx.priorResults,
    });
    const step = this.script(node.id, ctx.iteration);
    if (step.next !== undefined) {
      await writeFile(path.join(ctx.outputsDir, "next.json"), JSON.stringify(step.next));
    }
    if (step.result !== undefined) {
      await writeFile(path.join(ctx.outputsDir, "result.json"), JSON.stringify(step.result));
    }
    yield step.status;
  }

  ids(): string[] {
    return this.dispatches.map((d) => d.nodeId);
  }
}

/** Every node but `evaluate` succeeds; `evaluate` follows `evaluateStep`. */
function evaluating(evaluateStep: (iteration: number) => Step, type = "fake"): WritingExecutor {
  return new WritingExecutor(
    (id, iteration) => (id === "evaluate" ? evaluateStep(iteration) : { status: succeeded }),
    type,
  );
}

/**
 * implement → checks_gate → evaluate. evaluate routes to implement (budget
 * 2) or checks_gate (budget 3), declares a value edge on result.decision to
 * `audit`, and outcome edges on_success → verify, on_failure → recover,
 * on_error → err. The routing node's `next` output is synthesized as the
 * loader does.
 */
function routed(opts: { routes?: FactoryNode["routes"]; edges?: FactoryEdge[] } = {}): Factory {
  const terminal = { executor: "fake", terminal: true };
  const factory: Factory = {
    name: "routed",
    nodes: {
      implement: { executor: "fake", start: true, with: { prompt: "trav={{ edge.traversals }}" } },
      checks_gate: { executor: "fake", with: { prompt: "trav={{ edge.traversals }}" } },
      evaluate: {
        executor: "fake",
        routes: opts.routes ?? [
          { to: "implement", max_traversals: 2 },
          { to: "checks_gate", max_traversals: 3 },
        ],
        outputs: { result: { type: "value", required: false } },
      },
      audit: terminal,
      verify: terminal,
      recover: terminal,
      err: terminal,
    },
    edges: opts.edges ?? [
      { from: "implement", to: "checks_gate", when: "on_success" },
      { from: "checks_gate", to: "evaluate", when: "on_success" },
      { from: "evaluate", to: "audit", when: { output: "result.decision", equals: "audit" } },
      { from: "evaluate", to: "verify", when: "on_success" },
      { from: "evaluate", to: "recover", when: "on_failure" },
      { from: "evaluate", to: "err", when: "on_error" },
    ],
  };
  synthesizeRouteOutputs(factory, "/tmp/factories/f.yaml");
  return factory;
}

function wrap(factory: Factory): LoadedFactory {
  return { factory, sourcePath: "/tmp/factories/f.yaml", sourceDir: "/tmp/factories" };
}

function registryWith(exec: NodeExecutor): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(exec);
  return registry;
}

function routeLines(seen: EmittedEvent[]): string[] {
  return seen
    .filter((s) => s.event.kind === "runner-action" && s.event.line.startsWith("route:"))
    .map((s) => (s.event as { line: string }).line);
}

describe("node-chosen routing (ADR 0055)", () => {
  let dir: string;
  let home: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-routes-run-"));
    home = process.env.MINIFAC_HOME;
    process.env.MINIFAC_HOME = path.join(dir, "home");
  });

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (home === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = home;
    await rm(dir, { recursive: true, force: true });
  });

  describe("a terminal routing node (the terminal_routes load warning)", () => {
    // evaluate is terminal: a success ends the run before `next` is read.
    function terminalRouted(): Factory {
      const factory = routed({
        edges: [
          { from: "implement", to: "checks_gate", when: "on_success" },
          { from: "checks_gate", to: "evaluate", when: "on_success" },
        ],
      });
      const { implement, checks_gate, evaluate } = factory.nodes;
      if (!implement || !checks_gate || !evaluate) throw new Error("fixture");
      factory.nodes = { implement, checks_gate, evaluate: { ...evaluate, terminal: true } };
      return factory;
    }

    it("ends the run on a success, even with a next naming a route", async () => {
      const exec = evaluating(() => ({ next: "implement", status: succeeded }));
      const seen: EmittedEvent[] = [];
      const result = await runFactory(wrap(terminalRouted()), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual(["implement", "checks_gate", "evaluate"]);
      expect(result).toMatchObject({
        status: "succeeded",
        reason: "terminal_node_succeeded",
        proximateNodeId: "evaluate",
      });
      expect(routeLines(seen)).toEqual([]);
    });

    it("takes the route on a judged failure", async () => {
      const exec = evaluating((i) =>
        i === 1 ? { next: "implement", status: failed } : { next: null, status: succeeded },
      );
      const result = await runFactory(wrap(terminalRouted()), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual([
        "implement",
        "checks_gate",
        "evaluate",
        "implement",
        "checks_gate",
        "evaluate",
      ]);
      expect(result).toMatchObject({ status: "succeeded", proximateNodeId: "evaluate" });
    });
  });

  describe("precedence: next > value edges > outcome edges", () => {
    it("a next naming a route takes that route alone, skipping a matching value edge and on_success", async () => {
      const exec = evaluating((i) =>
        i === 1
          ? { next: "checks_gate", result: { decision: "audit" }, status: succeeded }
          : { next: null, status: succeeded },
      );
      const seen: EmittedEvent[] = [];
      const result = await runFactory(wrap(routed()), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual([
        "implement",
        "checks_gate",
        "evaluate",
        "checks_gate",
        "evaluate",
        "verify",
      ]);
      expect(result).toMatchObject({ status: "succeeded", proximateNodeId: "verify" });
      expect(routeLines(seen)).toEqual([
        'route: node "evaluate" chose "checks_gate" (chosen_by: evaluate)',
      ]);
    });

    it("a judged failure with a valid next takes the route, not on_failure", async () => {
      const exec = evaluating((i) =>
        i === 1 ? { next: "implement", status: failed } : { next: null, status: succeeded },
      );
      await runFactory(wrap(routed()), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual([
        "implement",
        "checks_gate",
        "evaluate",
        "implement",
        "checks_gate",
        "evaluate",
        "verify",
      ]);
    });

    it("next: null falls through to a matching value edge", async () => {
      const exec = evaluating(() => ({
        next: null,
        result: { decision: "audit" },
        status: succeeded,
      }));
      await runFactory(wrap(routed()), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual(["implement", "checks_gate", "evaluate", "audit"]);
    });

    it("next: null with no matching value edge falls through to on_success", async () => {
      const exec = evaluating(() => ({ next: null, status: succeeded }));
      const seen: EmittedEvent[] = [];
      await runFactory(wrap(routed()), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual(["implement", "checks_gate", "evaluate", "verify"]);
      expect(routeLines(seen)).toEqual([]);
    });

    it("an absent next follows the outcome edges (on_failure for a judged failure)", async () => {
      const exec = evaluating(() => ({ status: failed }));
      await runFactory(wrap(routed()), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual(["implement", "checks_gate", "evaluate", "recover"]);
    });

    it("an error ignores a written next and routes on_error", async () => {
      const exec = evaluating(() => ({ next: "checks_gate", status: crashed }));
      const seen: EmittedEvent[] = [];
      await runFactory(wrap(routed()), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual(["implement", "checks_gate", "evaluate", "err"]);
      expect(routeLines(seen)).toEqual([]);
    });
  });

  describe("an off-list next", () => {
    it("fails the node with output_schema_mismatch, is not indexed, and routes on_failure", async () => {
      const store = SqliteRunStore.open(path.join(dir, "runs.db"));
      try {
        const exec = evaluating(() => ({ next: "verify", status: succeeded }));
        const result = await runFactory(wrap(routed()), {
          registry: registryWith(exec),
          store,
          runId: "run-off-list",
        });
        expect(exec.ids()).toEqual(["implement", "checks_gate", "evaluate", "recover"]);
        expect(result).toMatchObject({ status: "succeeded", proximateNodeId: "recover" });
        const recover = exec.dispatches.find((d) => d.nodeId === "recover");
        const evaluate = recover?.prior.find((p) => p.nodeId === "evaluate");
        expect(evaluate).toMatchObject({ status: "failed", outcome: "failure" });
        expect(evaluate?.reason).toMatch(/^output_schema_mismatch: output "next"/);
        expect(evaluate?.outputs?.next).toBeUndefined();
        const rows = await store.getNodeOutputs("run-off-list", { nodeId: "evaluate" });
        expect(rows.map((r) => r.outputKey)).not.toContain("next");
      } finally {
        await store.close();
      }
    });
  });

  describe("budgets on routes", () => {
    const alwaysImplement = () => evaluating(() => ({ next: "implement", status: succeeded }));

    it("an exhausted route does not fall back to on_success; the run ends budget_exhausted", async () => {
      const exec = alwaysImplement();
      const seen: EmittedEvent[] = [];
      const result = await runFactory(wrap(routed()), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual([
        "implement",
        "checks_gate",
        "evaluate",
        "implement",
        "checks_gate",
        "evaluate",
        "implement",
        "checks_gate",
        "evaluate",
      ]);
      expect(exec.ids()).not.toContain("verify");
      expect(result).toMatchObject({ status: "failed", reason: "budget_exhausted" });
      expect(routeLines(seen)).toHaveLength(2);
    });

    it("a failed node whose chosen route is exhausted ends budget_exhausted, not on_failure", async () => {
      const exec = evaluating(() => ({ next: "implement", status: failed }));
      const result = await runFactory(wrap(routed()), { registry: registryWith(exec) });
      expect(exec.ids()).not.toContain("recover");
      expect(result).toMatchObject({
        status: "failed",
        reason: "budget_exhausted",
        proximateNodeId: "evaluate",
      });
    });

    it("{{ edge.traversals }} counts traversals of the route", async () => {
      const exec = alwaysImplement();
      await runFactory(wrap(routed()), { registry: registryWith(exec) });
      expect(exec.dispatches.filter((d) => d.nodeId === "implement").map((d) => d.prompt)).toEqual([
        "trav=0",
        "trav=1",
        "trav=2",
      ]);
    });

    describe("park and resume carry the route's count", () => {
      let store: SqliteRunStore;
      beforeEach(() => {
        store = SqliteRunStore.open(path.join(dir, "runs.db"));
      });
      afterEach(async () => {
        await store.close();
      });

      async function parkBeforeThirdImplement(runId: string) {
        const exec = alwaysImplement();
        const parked = await runFactory(wrap(routed()), {
          registry: registryWith(exec),
          store,
          runId,
          onNodeBoundary: (b) =>
            b.nodeId === "implement" && b.iteration === 3 ? "park" : "continue",
        });
        expect(parked.status).toBe("parked");
        expect(parked.parked?.edgeTraversals).toEqual({
          "implement->checks_gate:on_success": 2,
          "checks_gate->evaluate:on_success": 2,
          "evaluate->implement:route": 2,
        });
        expect(parked.parked?.via).toBe("evaluate->implement:route");
        const state = await resumeStateFromStore({ store, runId, at: "implement" });
        return { parked, state };
      }

      it("a resume rehydrates the count, renders it and exhausts on schedule", async () => {
        const { parked, state } = await parkBeforeThirdImplement("run-route-budget");
        const after = alwaysImplement();
        const resumed = await runFactory(wrap(routed()), {
          registry: registryWith(after),
          store,
          runId: "run-route-budget",
          resume: {
            ...state,
            reason: "pause",
            edgeTraversals: parked.parked?.edgeTraversals,
            via: parked.parked?.via,
          },
        });
        expect(after.dispatches.map((d) => `${d.nodeId}#${d.iteration}`)).toEqual([
          "implement#3",
          "checks_gate#3",
          "evaluate#3",
        ]);
        expect(after.dispatches[0]?.prompt).toBe("trav=2");
        expect(resumed).toMatchObject({ status: "failed", reason: "budget_exhausted" });
      });

      it("without the carried counts the route gets a fresh budget (control)", async () => {
        const { state } = await parkBeforeThirdImplement("run-route-control");
        const after = alwaysImplement();
        await runFactory(wrap(routed()), {
          registry: registryWith(after),
          store,
          runId: "run-route-control",
          resume: { ...state, reason: "pause" },
        });
        expect(after.ids().filter((id) => id === "implement")).toHaveLength(3);
      });
    });
  });

  it("each routed hop is persisted as a runner-action event carrying chosen_by and to", async () => {
    const store = SqliteRunStore.open(path.join(dir, "runs.db"));
    try {
      const exec = evaluating((i) => ({
        next: i === 1 ? "implement" : i === 2 ? "checks_gate" : null,
        status: succeeded,
      }));
      await runFactory(wrap(routed()), {
        registry: registryWith(exec),
        store,
        runId: "run-chosen",
      });
      const events = await store.getRunEvents("run-chosen");
      const hops = events.filter(
        (e) =>
          e.kind === "runner-action" &&
          (e.payload as { chosen_by?: string }).chosen_by !== undefined,
      );
      expect(
        hops.map((e) => ({ nodeId: e.nodeId, iteration: e.iteration, payload: e.payload })),
      ).toEqual([
        {
          nodeId: "evaluate",
          iteration: 1,
          payload: {
            kind: "runner-action",
            line: 'route: node "evaluate" chose "implement" (chosen_by: evaluate)',
            chosen_by: "evaluate",
            to: "implement",
          },
        },
        {
          nodeId: "evaluate",
          iteration: 2,
          payload: {
            kind: "runner-action",
            line: 'route: node "evaluate" chose "checks_gate" (chosen_by: evaluate)',
            chosen_by: "evaluate",
            to: "checks_gate",
          },
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("a graph without routes routes exactly as before and emits no route event", async () => {
    const factory = routed();
    // biome-ignore lint/style/noNonNullAssertion: declared above
    const evaluate = factory.nodes.evaluate!;
    evaluate.routes = undefined;
    evaluate.outputs = { result: { type: "value", required: false } };
    evaluate.max_iterations = 3;
    factory.edges.push({ from: "evaluate", to: "implement", when: "on_failure" });
    const exec = evaluating((i) => ({ next: "checks_gate", status: i === 1 ? failed : succeeded }));
    const seen: EmittedEvent[] = [];
    await runFactory(wrap(factory), { registry: registryWith(exec), onEvent: (e) => seen.push(e) });
    // on_failure fans out to recover and implement; a `next.json` on a
    // non-routing node is ignored.
    expect(exec.ids().slice(0, 4)).toEqual(["implement", "checks_gate", "evaluate", "recover"]);
    expect(routeLines(seen)).toEqual([]);
  });

  it("examples/routing.yaml follows the route evaluate chooses", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const loaded = await loadFactory(path.join(repoRoot, "examples", "routing.yaml"), repoRoot);
    // First verdict: a lint-only problem, back to checks_gate. Second: done.
    const exec = evaluating(
      (i) =>
        i === 1 ? { next: "checks_gate", status: succeeded } : { next: null, status: succeeded },
      "claude",
    );
    const seen: EmittedEvent[] = [];
    const result = await runFactory(loaded, {
      registry: registryWith(exec),
      onEvent: (e) => seen.push(e),
    });
    expect(exec.ids()).toEqual([
      "implement",
      "checks_gate",
      "review",
      "evaluate",
      "checks_gate",
      "review",
      "evaluate",
      "verify",
    ]);
    expect(result).toMatchObject({ status: "succeeded", proximateNodeId: "verify" });
    expect(routeLines(seen)).toEqual([
      'route: node "evaluate" chose "checks_gate" (chosen_by: evaluate)',
    ]);
    // The chosen `next` is indexed like any value output.
    const verify = exec.dispatches.find((d) => d.nodeId === "verify");
    const evaluate = verify?.prior.filter((p) => p.nodeId === "evaluate") ?? [];
    expect(evaluate.map((p) => Object.keys(p.outputs ?? {}))).toEqual([["next"], ["next"]]);
  });
});
