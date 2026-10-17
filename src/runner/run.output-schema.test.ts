import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { runFactory } from "./run.js";

// Output schema validation at node completion (ADR 0054). These run the real
// runner; the executor writes `result.json` into the node's outputs dir and
// then reports a terminal status.

const succeeded: NodeEvent = { kind: "status", status: "succeeded" };
/** A judged failure carrying its own REASON line (the shape `extractReason` reads). */
const failed: NodeEvent = {
  kind: "status",
  status: "failed",
  meta: { reason: "sentinel_failed", sentinel: "own_reason" },
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
  dispatches: Array<{ nodeId: string; prior: readonly NodeResult[] }> = [];

  constructor(private readonly script: (nodeId: string) => Step) {}

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    this.dispatches.push({ nodeId: node.id, prior: ctx.priorResults });
    const step = this.script(node.id);
    if (step.result !== undefined) {
      await writeFile(path.join(ctx.outputsDir, "result.json"), JSON.stringify(step.result));
    }
    yield step.status;
  }

  ids(): string[] {
    return this.dispatches.map((d) => d.nodeId);
  }
}

const verdictSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { enum: ["pass", "fail"] } },
};

/** `a` with on_success → s, on_error → e, on_failure → r. */
function graph(aNode: Factory["nodes"][string]): Factory {
  return {
    name: "schema",
    nodes: {
      a: aNode,
      s: { executor: "fake", terminal: true },
      e: { executor: "fake", terminal: true },
      r: { executor: "fake", terminal: true },
    },
    edges: [
      { from: "a", to: "s", when: "on_success" },
      { from: "a", to: "e", when: "on_error" },
      { from: "a", to: "r", when: "on_failure" },
    ],
  };
}

const schemaNode: Factory["nodes"][string] = {
  executor: "fake",
  outputs: { result: { type: "value", required: true, schema: verdictSchema } },
};

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

function terminalStatuses(seen: EmittedEvent[], nodeId: string): NodeEvent[] {
  return seen
    .filter((s) => s.nodeId === nodeId)
    .map((s) => s.event)
    .filter((e) => e.kind === "status" && e.status !== "started");
}

describe("output schema validation (ADR 0054)", () => {
  let dir: string;
  let home: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-output-schema-"));
    home = process.env.MINIFAC_HOME;
    process.env.MINIFAC_HOME = path.join(dir, "home");
  });

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (home === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = home;
    await rm(dir, { recursive: true, force: true });
  });

  it("a result that matches its schema succeeds, routes on_success and is indexed", async () => {
    const exec = new WritingExecutor((id) =>
      id === "a" ? { result: { verdict: "pass" }, status: succeeded } : { status: succeeded },
    );
    const result = await runFactory(wrap(graph(schemaNode)), { registry: registryWith(exec) });
    expect(exec.ids()).toEqual(["a", "s"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", status: "succeeded", outcome: "success" });
    const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
    expect(priorA?.reason).toBeNull();
    expect(priorA?.outputs?.result).toMatchObject({ type: "value" });
  });

  it("a mismatch fails the node with outcome failure, names pointer and keyword, routes on_failure (not on_error)", async () => {
    const store = SqliteRunStore.open(path.join(dir, "runs.db"));
    try {
      const exec = new WritingExecutor((id) =>
        id === "a" ? { result: { verdict: "maybe" }, status: succeeded } : { status: succeeded },
      );
      const seen: EmittedEvent[] = [];
      const runId = "run-output-schema";
      await runFactory(wrap(graph(schemaNode)), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
        store,
        runId,
      });
      // `a` declares on_error too; a schema mismatch is a judged failure.
      expect(exec.ids()).toEqual(["a", "r"]);
      const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
      expect(priorA).toMatchObject({ status: "failed", outcome: "failure", outputs: null });
      expect(priorA?.reason).toMatch(/^output_schema_mismatch: output "result" at \/verdict: enum/);

      const statuses = terminalStatuses(seen, "a");
      expect(statuses.map((e) => e.kind === "status" && [e.status, e.outcome])).toEqual([
        ["succeeded", "success"],
        ["failed", "failure"],
      ]);
      expect(statuses[1]).toMatchObject({
        meta: {
          reason: "output_schema_mismatch",
          mismatched_outputs: ["result"],
          schema_errors: {
            result: [expect.objectContaining({ pointer: "/verdict", keyword: "enum" })],
          },
        },
      });
      expect(stderrFor(seen, "a").some((l) => l.startsWith("output_schema_mismatch:"))).toBe(true);

      const rows = await store.getNodeExecutions(runId);
      expect(rows.map((r) => [r.nodeId, r.status, r.outcome])).toEqual([
        ["a", "failed", "failure"],
        ["r", "succeeded", "success"],
      ]);
    } finally {
      await store.close();
    }
  });

  describe("an optional (required: false) value output", () => {
    const optionalNode: Factory["nodes"][string] = {
      executor: "fake",
      outputs: { result: { type: "value", required: false, schema: verdictSchema } },
    };

    it("present but violating its schema fails the node, routes on_failure and is not indexed", async () => {
      const exec = new WritingExecutor((id) =>
        id === "a" ? { result: "pass", status: succeeded } : { status: succeeded },
      );
      const seen: EmittedEvent[] = [];
      const result = await runFactory(wrap(graph(optionalNode)), {
        registry: registryWith(exec),
        onEvent: (e) => seen.push(e),
      });
      expect(exec.ids()).toEqual(["a", "r"]);
      expect(result.log[0]).toMatchObject({ nodeId: "a", status: "failed", outcome: "failure" });
      const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
      expect(priorA).toMatchObject({ status: "failed", outcome: "failure", outputs: null });
      // A root violation: RFC 6901's "" as data, `(root)` in the reason.
      expect(priorA?.reason).toBe(
        'output_schema_mismatch: output "result" at (root): type (must be object)',
      );
      expect(terminalStatuses(seen, "a")[1]).toMatchObject({
        meta: {
          reason: "output_schema_mismatch",
          mismatched_outputs: ["result"],
          schema_errors: { result: [expect.objectContaining({ pointer: "", keyword: "type" })] },
        },
      });
    });

    it("absent, succeeds and routes on_success", async () => {
      const exec = new WritingExecutor(() => ({ status: succeeded }));
      await runFactory(wrap(graph(optionalNode)), { registry: registryWith(exec) });
      expect(exec.ids()).toEqual(["a", "s"]);
    });
  });

  it("a missing required output with a schema is still an error / missing_required_output", async () => {
    const exec = new WritingExecutor(() => ({ status: succeeded }));
    const result = await runFactory(wrap(graph(schemaNode)), { registry: registryWith(exec) });
    expect(exec.ids()).toEqual(["a", "e"]);
    expect(result.log[0]).toMatchObject({ nodeId: "a", status: "failed", outcome: "error" });
    const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
    expect(priorA?.reason).toBe("missing_required_output");
  });

  it("a missing required output wins over another output's mismatch", async () => {
    const node: Factory["nodes"][string] = {
      executor: "fake",
      outputs: {
        result: { type: "value", required: false, schema: verdictSchema },
        other: { type: "value", required: true },
      },
    };
    const exec = new WritingExecutor((id) =>
      id === "a" ? { result: { verdict: "maybe" }, status: succeeded } : { status: succeeded },
    );
    await runFactory(wrap(graph(node)), { registry: registryWith(exec) });
    expect(exec.ids()).toEqual(["a", "e"]);
    const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
    expect(priorA).toMatchObject({ outcome: "error", reason: "missing_required_output" });
  });

  it("a node that already failed keeps its own reason; the mismatch is a warning and not indexed", async () => {
    const exec = new WritingExecutor((id) =>
      id === "a" ? { result: { verdict: "maybe" }, status: failed } : { status: succeeded },
    );
    const seen: EmittedEvent[] = [];
    await runFactory(wrap(graph(schemaNode)), {
      registry: registryWith(exec),
      onEvent: (e) => seen.push(e),
    });
    expect(exec.ids()).toEqual(["a", "r"]);
    const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
    expect(priorA).toMatchObject({ status: "failed", outcome: "failure", reason: "own_reason" });
    expect(priorA?.outputs).toBeNull();
    const lines = stderrFor(seen, "a");
    expect(lines.some((l) => l.includes("do not match their schema: result"))).toBe(true);
    expect(lines.some((l) => l.includes('output "result" at /verdict: enum'))).toBe(true);
    expect(terminalStatuses(seen, "a")).toHaveLength(1);
  });

  it("a node without a schema accepts any JSON value exactly as before", async () => {
    const node: Factory["nodes"][string] = {
      executor: "fake",
      outputs: { result: { type: "value", required: true } },
    };
    const exec = new WritingExecutor((id) =>
      id === "a" ? { result: { verdict: "maybe" }, status: succeeded } : { status: succeeded },
    );
    const seen: EmittedEvent[] = [];
    await runFactory(wrap(graph(node)), {
      registry: registryWith(exec),
      onEvent: (e) => seen.push(e),
    });
    expect(exec.ids()).toEqual(["a", "s"]);
    const priorA = exec.dispatches[1]?.prior.find((p) => p.nodeId === "a");
    expect(priorA).toMatchObject({ status: "succeeded", outcome: "success", reason: null });
    expect(stderrFor(seen, "a")).toEqual([]);
  });
});
