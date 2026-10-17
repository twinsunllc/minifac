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
import type { LoadedFactory } from "../factory/loader.js";
import type { Factory, FactoryEdge } from "../factory/schema.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import { resumeStateFromStore } from "./resume.js";
import { runFactory } from "./run.js";

// Value-conditioned edges at run time (ADR 0055). These run the real runner;
// the executor writes `result.json` into the node's outputs dir and then
// reports a terminal status.

const succeeded: NodeEvent = { kind: "status", status: "succeeded" };
/** A judged failure: the node ran and said no. */
const failed: NodeEvent = { kind: "status", status: "failed" };
/** An error: the executor could not produce a judgment. */
const crashed: NodeEvent = {
  kind: "status",
  status: "failed",
  meta: { exitCode: 137 },
  outcome: "error",
};

interface Step {
  /** JSON written to `<outputsDir>/result.json`; undefined writes nothing. */
  result?: unknown;
  status: NodeEvent;
}

class WritingExecutor implements NodeExecutor {
  readonly type = "fake";
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  readonly supportsResume = false;
  dispatches: Array<{ nodeId: string; iteration: number; prompt: string }> = [];

  constructor(private readonly script: (nodeId: string, iteration: number) => Step) {}

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    this.dispatches.push({
      nodeId: node.id,
      iteration: ctx.iteration,
      prompt: typeof node.with?.prompt === "string" ? node.with.prompt : "",
    });
    const step = this.script(node.id, ctx.iteration);
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
function evaluating(evaluateStep: (iteration: number) => Step): WritingExecutor {
  return new WritingExecutor((id, iteration) =>
    id === "evaluate" ? evaluateStep(iteration) : { status: succeeded },
  );
}

const DECISION_SCHEMA = {
  type: "object",
  properties: { decision: { enum: ["approve", "revise", "escalate"] } },
};

const REVISE_KEY = 'evaluate->implement:output:result.decision="revise"';

const valueEdges: FactoryEdge[] = [
  { from: "evaluate", to: "verify", when: { output: "result.decision", equals: "approve" } },
  {
    from: "evaluate",
    to: "implement",
    max_traversals: 2,
    when: { output: "result.decision", equals: "revise" },
  },
  { from: "evaluate", to: "escalate", when: { output: "result.decision", in: ["escalate"] } },
];

/**
 * implement → evaluate, then evaluate's three-way value route plus its
 * outcome edges: on_success → fallback, on_failure → recover, on_error → err.
 */
function threeWay(opts: { schema?: unknown; outcomeEdges?: FactoryEdge[] } = {}): Factory {
  const terminal = { executor: "fake", terminal: true };
  return {
    name: "three-way",
    nodes: {
      implement: { executor: "fake", start: true, with: { prompt: "trav={{ edge.traversals }}" } },
      evaluate: {
        executor: "fake",
        outputs: {
          result: {
            type: "value",
            required: false,
            ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
          },
        },
      },
      verify: terminal,
      escalate: terminal,
      fallback: terminal,
      recover: terminal,
      err: terminal,
    },
    edges: [
      { from: "implement", to: "evaluate", when: "on_success" },
      ...valueEdges,
      ...(opts.outcomeEdges ?? [
        { from: "evaluate", to: "fallback", when: "on_success" },
        { from: "evaluate", to: "recover", when: "on_failure" },
        { from: "evaluate", to: "err", when: "on_error" },
      ]),
    ],
  };
}

function wrap(factory: Factory): LoadedFactory {
  return { factory, sourcePath: "/tmp/factories/f.yaml", sourceDir: "/tmp/factories" };
}

function registryWith(exec: NodeExecutor): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(exec);
  return registry;
}

function stderrFor(seen: EmittedEvent[], nodeId: string): string[] {
  return seen
    .filter((s) => s.nodeId === nodeId && s.event.kind === "stderr")
    .map((s) => (s.event as { line: string }).line);
}

const NO_MATCH = (when: string) =>
  `value_edges: node "evaluate" matched no value edge; following ${when} edges`;

describe("value-conditioned edges (ADR 0055)", () => {
  let dir: string;
  let home: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-value-edges-run-"));
    home = process.env.MINIFAC_HOME;
    process.env.MINIFAC_HOME = path.join(dir, "home");
  });

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (home === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = home;
    await rm(dir, { recursive: true, force: true });
  });

  describe("a three-way route dispatches exactly the matching successor", () => {
    it("approve → verify", async () => {
      const exec = evaluating(() => ({ result: { decision: "approve" }, status: succeeded }));
      const result = await runFactory(wrap(threeWay({ schema: DECISION_SCHEMA })), {
        registry: registryWith(exec),
      });
      expect(exec.ids()).toEqual(["implement", "evaluate", "verify"]);
      expect(result).toMatchObject({ status: "succeeded", proximateNodeId: "verify" });
    });

    it("escalate → escalate", async () => {
      const exec = evaluating(() => ({ result: { decision: "escalate" }, status: succeeded }));
      await runFactory(wrap(threeWay({ schema: DECISION_SCHEMA })), {
        registry: registryWith(exec),
      });
      expect(exec.ids()).toEqual(["implement", "evaluate", "escalate"]);
    });

    it("revise → implement, and the next verdict routes again", async () => {
      const exec = evaluating((i) => ({
        result: { decision: i === 1 ? "revise" : "approve" },
        status: succeeded,
      }));
      await runFactory(wrap(threeWay({ schema: DECISION_SCHEMA })), {
        registry: registryWith(exec),
      });
      expect(exec.ids()).toEqual(["implement", "evaluate", "implement", "evaluate", "verify"]);
    });
  });

  describe("no-match fallback", () => {
    it("on success follows the plain on_success edge and records the miss", async () => {
      const store = SqliteRunStore.open(path.join(dir, "runs.db"));
      try {
        const exec = evaluating(() => ({ result: { decision: "other" }, status: succeeded }));
        const seen: EmittedEvent[] = [];
        await runFactory(wrap(threeWay()), {
          registry: registryWith(exec),
          onEvent: (e) => seen.push(e),
          store,
          runId: "run-no-match",
        });
        expect(exec.ids()).toEqual(["implement", "evaluate", "fallback"]);
        expect(stderrFor(seen, "evaluate")).toContain(NO_MATCH("on_success"));
        const events = await store.getRunEvents("run-no-match");
        expect(
          events.some(
            (e) => e.kind === "stderr" && JSON.stringify(e.payload).includes("value_edges:"),
          ),
        ).toBe(true);
      } finally {
        await store.close();
      }
    });

    it("on a judged failure follows on_failure", async () => {
      const exec = evaluating(() => ({ result: { decision: "other" }, status: failed }));
      const seen: EmittedEvent[] = [];
      await runFactory(wrap(threeWay()), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual(["implement", "evaluate", "recover"]);
      expect(stderrFor(seen, "evaluate")).toContain(NO_MATCH("on_failure"));
    });

    it("a failed node with no fallback edge ends node_failed", async () => {
      const exec = evaluating(() => ({ result: { decision: "other" }, status: failed }));
      // Drop the outcome edges' targets too, or they become start nodes.
      const factory = threeWay({ outcomeEdges: [] });
      for (const id of ["fallback", "recover", "err"]) delete factory.nodes[id];
      const result = await runFactory(wrap(factory), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual(["implement", "evaluate"]);
      expect(result).toMatchObject({
        status: "failed",
        reason: "node_failed",
        proximateNodeId: "evaluate",
      });
    });

    it("a missing value output matches no value edge", async () => {
      const exec = evaluating(() => ({ status: succeeded }));
      const seen: EmittedEvent[] = [];
      await runFactory(wrap(threeWay()), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual(["implement", "evaluate", "fallback"]);
      expect(stderrFor(seen, "evaluate")).toContain(NO_MATCH("on_success"));
    });

    it("a value that mismatches its schema is not indexed, so it matches nothing and routes on_failure", async () => {
      // `decision: escalate` would match, but `extra` breaks the schema.
      const strict = { ...DECISION_SCHEMA, additionalProperties: false };
      const exec = evaluating(() => ({
        result: { decision: "escalate", extra: 1 },
        status: succeeded,
      }));
      await runFactory(wrap(threeWay({ schema: strict })), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual(["implement", "evaluate", "recover"]);
    });
  });

  describe("outcomes", () => {
    it("a judged failure whose value matches takes the value edge", async () => {
      const exec = evaluating(() => ({ result: { decision: "escalate" }, status: failed }));
      await runFactory(wrap(threeWay()), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual(["implement", "evaluate", "escalate"]);
    });

    it("an error never takes a value edge, even when its value matches; it routes on_error", async () => {
      const exec = evaluating(() => ({ result: { decision: "escalate" }, status: crashed }));
      const seen: EmittedEvent[] = [];
      await runFactory(wrap(threeWay()), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual(["implement", "evaluate", "err"]);
      expect(stderrFor(seen, "evaluate").some((l) => l.startsWith("value_edges:"))).toBe(false);
    });
  });

  it("value edges on different paths that both match are all traversed", async () => {
    const factory: Factory = {
      name: "fan-out",
      nodes: {
        evaluate: { executor: "fake", outputs: { result: { type: "value", required: true } } },
        verify: { executor: "fake" },
        audit: { executor: "fake" },
        fallback: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "evaluate", to: "verify", when: { output: "result.decision", equals: "approve" } },
        { from: "evaluate", to: "audit", when: { output: "result.risk", equals: "high" } },
        { from: "evaluate", to: "fallback", when: "on_success" },
      ],
    };
    const exec = evaluating(() => ({
      result: { decision: "approve", risk: "high" },
      status: succeeded,
    }));
    await runFactory(wrap(factory), { registry: registryWith(exec) });
    expect(exec.ids()).toEqual(["evaluate", "verify", "audit"]);
  });

  describe("budgets on value edges", () => {
    const alwaysRevise = () =>
      evaluating(() => ({ result: { decision: "revise" }, status: succeeded }));

    it("max_traversals bounds a value-edge loop, which ends budget_exhausted without falling back", async () => {
      const exec = alwaysRevise();
      const result = await runFactory(wrap(threeWay({ schema: DECISION_SCHEMA })), {
        registry: registryWith(exec),
      });
      expect(exec.ids()).toEqual([
        "implement",
        "evaluate",
        "implement",
        "evaluate",
        "implement",
        "evaluate",
      ]);
      expect(exec.ids()).not.toContain("fallback");
      expect(result).toMatchObject({ status: "failed", reason: "budget_exhausted" });
    });

    describe("park and resume carry the value edge's count", () => {
      let store: SqliteRunStore;
      beforeEach(() => {
        store = SqliteRunStore.open(path.join(dir, "runs.db"));
      });
      afterEach(async () => {
        await store.close();
      });

      async function parkBeforeThirdImplement(runId: string) {
        const exec = alwaysRevise();
        const parked = await runFactory(wrap(threeWay({ schema: DECISION_SCHEMA })), {
          registry: registryWith(exec),
          store,
          runId,
          onNodeBoundary: (b) =>
            b.nodeId === "implement" && b.iteration === 3 ? "park" : "continue",
        });
        expect(parked.status).toBe("parked");
        expect(parked.parked?.edgeTraversals).toEqual({
          "implement->evaluate:on_success": 2,
          [REVISE_KEY]: 2,
        });
        expect(parked.parked?.via).toBe(REVISE_KEY);
        const state = await resumeStateFromStore({ store, runId, at: "implement" });
        return { parked, state };
      }

      it("a resume rehydrates the count, renders it and exhausts on schedule", async () => {
        const { parked, state } = await parkBeforeThirdImplement("run-value-budget");
        const after = alwaysRevise();
        const resumed = await runFactory(wrap(threeWay({ schema: DECISION_SCHEMA })), {
          registry: registryWith(after),
          store,
          runId: "run-value-budget",
          resume: {
            ...state,
            reason: "pause",
            edgeTraversals: parked.parked?.edgeTraversals,
            via: parked.parked?.via,
          },
        });
        expect(after.dispatches.map((d) => `${d.nodeId}#${d.iteration}`)).toEqual([
          "implement#3",
          "evaluate#3",
        ]);
        expect(after.dispatches[0]?.prompt).toBe("trav=2");
        expect(resumed).toMatchObject({ status: "failed", reason: "budget_exhausted" });
      });

      it("without the carried counts the loop gets a fresh budget (control)", async () => {
        const { state } = await parkBeforeThirdImplement("run-value-control");
        const after = alwaysRevise();
        await runFactory(wrap(threeWay({ schema: DECISION_SCHEMA })), {
          registry: registryWith(after),
          store,
          runId: "run-value-control",
          resume: { ...state, reason: "pause" },
        });
        expect(after.ids().filter((id) => id === "implement")).toHaveLength(3);
      });
    });
  });
});
