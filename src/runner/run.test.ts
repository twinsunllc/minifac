import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Brief } from "../brief/loader.js";
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
import type {
  AppendEventInput,
  CreateRunInput,
  FinalizeRunInput,
  GetEventsOptions,
  GetNodeOutputsFilter,
  ListRunsFilter,
  NodeOutputIndex,
  NodeOutputRow,
  RecordNodeEndInput,
  RunStore,
  StoredEvent,
  StoredRun,
} from "../storage/run-store.js";
import { runFactory } from "./run.js";

interface RecordedEvent extends AppendEventInput {
  seq: number;
}

class FakeStore implements RunStore {
  runs = new Map<string, StoredRun>();
  events = new Map<string, RecordedEvent[]>();
  nodeStarts: Array<{ runId: string; nodeId: string; iteration: number; at: number }> = [];
  nodeEnds: Array<{
    runId: string;
    nodeId: string;
    iteration: number;
    end: RecordNodeEndInput;
  }> = [];
  nodeOutputs: Array<{
    runId: string;
    nodeId: string;
    iteration: number;
    outputs: NodeOutputIndex;
  }> = [];
  finalizeCalls: Array<{ runId: string; input: FinalizeRunInput }> = [];

  async createRun(input: CreateRunInput): Promise<void> {
    this.runs.set(input.id, {
      id: input.id,
      factoryPath: input.factoryPath,
      factoryName: input.factoryName,
      briefPath: input.briefPath ?? null,
      change: input.change ?? null,
      baseBranch: input.baseBranch ?? null,
      worktreePath: input.worktreePath ?? null,
      branchName: input.branchName ?? null,
      status: "running",
      reason: null,
      proximateNodeId: null,
      startedAt: input.startedAt,
      endedAt: null,
    });
    this.events.set(input.id, []);
  }
  async appendEvent(runId: string, event: AppendEventInput): Promise<StoredEvent> {
    const arr = this.events.get(runId) ?? [];
    const seq = arr.length;
    const stored: RecordedEvent = { ...event, seq };
    arr.push(stored);
    this.events.set(runId, arr);
    return { ...event, seq };
  }
  async recordNodeStart(
    runId: string,
    nodeId: string,
    iteration: number,
    at: number,
  ): Promise<void> {
    this.nodeStarts.push({ runId, nodeId, iteration, at });
  }
  async recordNodeEnd(
    runId: string,
    nodeId: string,
    iteration: number,
    end: RecordNodeEndInput,
  ): Promise<void> {
    this.nodeEnds.push({ runId, nodeId, iteration, end });
  }
  async recordNodeOutputs(
    runId: string,
    nodeId: string,
    iteration: number,
    outputs: NodeOutputIndex,
  ): Promise<void> {
    if (Object.keys(outputs).length === 0) return;
    this.nodeOutputs.push({ runId, nodeId, iteration, outputs });
  }
  async getNodeOutputs(runId: string, filter?: GetNodeOutputsFilter): Promise<NodeOutputRow[]> {
    const rows: NodeOutputRow[] = [];
    for (const e of this.nodeOutputs) {
      if (e.runId !== runId) continue;
      if (filter?.nodeId !== undefined && e.nodeId !== filter.nodeId) continue;
      if (filter?.iteration !== undefined && e.iteration !== filter.iteration) continue;
      for (const [key, entry] of Object.entries(e.outputs)) {
        rows.push({
          runId: e.runId,
          nodeId: e.nodeId,
          iteration: e.iteration,
          outputKey: key,
          outputType: entry.type,
          path: entry.path,
          size: entry.size,
          mtime: entry.mtime,
        });
      }
    }
    rows.sort(
      (a, b) =>
        a.nodeId.localeCompare(b.nodeId) ||
        a.iteration - b.iteration ||
        a.outputKey.localeCompare(b.outputKey),
    );
    return rows;
  }
  async finalizeRun(runId: string, input: FinalizeRunInput): Promise<void> {
    this.finalizeCalls.push({ runId, input });
    const r = this.runs.get(runId);
    if (r) {
      r.status = input.status;
      r.reason = input.reason ?? null;
      r.proximateNodeId = input.proximateNodeId ?? null;
      r.endedAt = input.endedAt;
    }
  }
  async getRun(runId: string): Promise<StoredRun | null> {
    return this.runs.get(runId) ?? null;
  }
  async listRuns(_filter?: ListRunsFilter): Promise<StoredRun[]> {
    return [...this.runs.values()];
  }
  async getRunEvents(runId: string, _opts?: GetEventsOptions): Promise<StoredEvent[]> {
    return (this.events.get(runId) ?? []).map((e) => ({ ...e }));
  }
  async close(): Promise<void> {}
}

type Script = (ctx: RunContext, node: ResolvedNode) => Iterable<NodeEvent>;

class FakeExecutor implements NodeExecutor {
  readonly type: string;
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  /** Per-node scripts keyed by node id. The same script runs every iteration. */
  scripts: Map<string, Script>;
  /** Optional capture of contexts seen, per node id. */
  contexts: Map<string, RunContext[]> = new Map();
  /** Capture of resolved nodes seen, per node id (used to assert against the
   * prompt the runner handed to the executor). */
  nodes: Map<string, ResolvedNode[]> = new Map();

  constructor(type: string, scripts: Record<string, Script>) {
    this.type = type;
    this.scripts = new Map(Object.entries(scripts));
  }

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    const cList = this.contexts.get(node.id) ?? [];
    cList.push(ctx);
    this.contexts.set(node.id, cList);
    const nList = this.nodes.get(node.id) ?? [];
    nList.push(node);
    this.nodes.set(node.id, nList);
    const script = this.scripts.get(node.id);
    if (!script) {
      yield { kind: "status", status: "failed", meta: { reason: "no_script" } };
      return;
    }
    for (const evt of script(ctx, node)) {
      yield evt;
    }
  }
}

function wrap(factory: Factory, sourceDir = "/tmp/factories"): LoadedFactory {
  return {
    factory,
    sourcePath: path.join(sourceDir, "f.yaml"),
    sourceDir,
  };
}

const succeeded: NodeEvent = { kind: "status", status: "succeeded" };
const failed: NodeEvent = { kind: "status", status: "failed" };

describe("runFactory", () => {
  it("runs a single terminal node end-to-end (success)", async () => {
    const factory: Factory = {
      name: "f",
      nodes: { a: { executor: "fake", terminal: true } },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [{ kind: "stdout", line: "hi" }, succeeded],
    });
    const registry = new ExecutorRegistry();
    registry.register(exec);
    const result = await runFactory(wrap(factory), { registry });
    expect(result.status).toBe("succeeded");
    expect(result.reason).toBe("terminal_node_succeeded");
    expect(result.proximateNodeId).toBe("a");
    expect(result.log).toHaveLength(1);
    expect(result.log[0]?.status).toBe("succeeded");
  });

  it("schedules start nodes and then successors via on_success", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false },
        b: { executor: "fake", terminal: true },
      },
      edges: [{ from: "a", to: "b", when: "on_success" }],
    };
    const order: string[] = [];
    const exec = new FakeExecutor("fake", {
      a: () => {
        order.push("a");
        return [succeeded];
      },
      b: () => {
        order.push("b");
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const result = await runFactory(wrap(factory), { registry: reg });
    expect(result.status).toBe("succeeded");
    expect(order).toEqual(["a", "b"]);
  });

  it("schedules multiple start nodes before successors", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false },
        b: { executor: "fake", terminal: false },
        c: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "a", to: "c", when: "on_success" },
        { from: "b", to: "c", when: "on_success" },
      ],
    };
    const order: string[] = [];
    const exec = new FakeExecutor("fake", {
      a: () => {
        order.push("a");
        return [succeeded];
      },
      b: () => {
        order.push("b");
        return [succeeded];
      },
      c: () => {
        order.push("c");
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg });
    // FIFO: a, b queued first; then c enqueued twice but iteration budget
    // prevents the second execution implicitly via the success-then-stop
    // termination. Either way, a and b precede c.
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("does NOT traverse default (on_success) edges when the source fails", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false },
        b: { executor: "fake", terminal: true },
      },
      edges: [{ from: "a", to: "b", when: "on_success" }],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [failed],
      b: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const result = await runFactory(wrap(factory), { registry: reg });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("node_failed");
    expect(result.proximateNodeId).toBe("a");
    expect(result.log.map((l) => l.nodeId)).toEqual(["a"]);
  });

  it("traverses on_failure edges when the source fails", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false },
        r: { executor: "fake", terminal: true },
      },
      edges: [{ from: "a", to: "r", when: "on_failure" }],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [failed],
      r: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const result = await runFactory(wrap(factory), { registry: reg });
    expect(result.status).toBe("succeeded");
    expect(result.proximateNodeId).toBe("r");
  });

  it("enforces edge max_traversals (budget exhausted)", async () => {
    // a fails, on_failure → a (loop). Edge cap = 2.
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false },
        t: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "a", to: "a", when: "on_failure", max_traversals: 2 },
        { from: "a", to: "t", when: "on_success" },
      ],
    };
    let count = 0;
    const exec = new FakeExecutor("fake", {
      a: () => {
        count++;
        return [failed];
      },
      t: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const result = await runFactory(wrap(factory), { registry: reg });
    // 1st a fails -> traverse 1, run a again. 2nd a fails -> traverse 2, run
    // a again. 3rd a fails -> traversal budget exhausted, no recovery.
    expect(count).toBe(3);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("budget_exhausted");
  });

  it("enforces node max_iterations", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false, max_iterations: 2 },
        t: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "a", to: "a", when: "on_failure" },
        { from: "a", to: "t", when: "on_success" },
      ],
    };
    let count = 0;
    const exec = new FakeExecutor("fake", {
      a: () => {
        count++;
        return [failed];
      },
      t: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const result = await runFactory(wrap(factory), { registry: reg });
    expect(count).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("budget_exhausted");
  });

  it("supports terminal node participating in a cycle (success on second iter)", async () => {
    // p -> v ; v -> p on_failure. v is terminal.
    const factory: Factory = {
      name: "f",
      nodes: {
        p: { executor: "fake", terminal: false, max_iterations: 5 },
        v: { executor: "fake", terminal: true, max_iterations: 5 },
      },
      edges: [
        { from: "p", to: "v", when: "on_success" },
        { from: "v", to: "p", when: "on_failure" },
      ],
    };
    let vRuns = 0;
    const exec = new FakeExecutor("fake", {
      p: () => [succeeded],
      v: () => {
        vRuns++;
        return vRuns === 1 ? [failed] : [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const result = await runFactory(wrap(factory), { registry: reg });
    expect(result.status).toBe("succeeded");
    expect(result.proximateNodeId).toBe("v");
  });

  it("accumulates priorResults across nodes, in completion order", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false },
        b: { executor: "fake", terminal: true },
      },
      edges: [{ from: "a", to: "b", when: "on_success" }],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [
        { kind: "stdout", line: "a-line-1" },
        { kind: "stdout", line: "a-line-2" },
        succeeded,
      ],
      b: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg });
    const ctxB = exec.contexts.get("b")?.[0];
    expect(ctxB).toBeDefined();
    const prior = ctxB?.priorResults ?? [];
    expect(prior).toHaveLength(1);
    const entry = prior[0];
    expect(entry?.nodeId).toBe("a");
    expect(entry?.iteration).toBe(1);
    expect(entry?.status).toBe("succeeded");
    expect(entry?.reason).toBeNull();
    expect(typeof entry?.startedAt).toBe("number");
    expect(typeof entry?.endedAt).toBe("number");
    // The shape contains exactly the documented keys — no extras.
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      [
        "endedAt",
        "iteration",
        "nodeId",
        "nudges_used",
        "outputs",
        "reason",
        "startedAt",
        "status",
      ].sort(),
    );
    expect(entry?.nudges_used).toBe(0);
  });

  it("P on iteration 2 sees P iter-1 result and V iter-1 result", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        p: { executor: "fake", terminal: false, max_iterations: 3 },
        v: { executor: "fake", terminal: true, max_iterations: 3 },
      },
      edges: [
        { from: "p", to: "v", when: "on_success" },
        { from: "v", to: "p", when: "on_failure" },
      ],
    };
    let vRuns = 0;
    const exec = new FakeExecutor("fake", {
      p: () => [{ kind: "stdout", line: "p-out" }, succeeded],
      v: () => {
        vRuns++;
        return vRuns === 1
          ? [
              { kind: "stderr", line: "v-fail" },
              {
                kind: "status",
                status: "failed",
                meta: { reason: "sentinel_failed", sentinel: "verify hit error" },
              } as NodeEvent,
            ]
          : [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg });
    const pCtxs = exec.contexts.get("p");
    expect(pCtxs?.length).toBe(2);
    const iter2 = pCtxs?.[1];
    const prior = iter2?.priorResults ?? [];
    expect(prior).toHaveLength(2);
    const pEntry = prior.find((e) => e.nodeId === "p" && e.iteration === 1);
    expect(pEntry).toBeDefined();
    expect(pEntry?.status).toBe("succeeded");
    expect(pEntry?.reason).toBeNull();
    const vEntry = prior.find((e) => e.nodeId === "v" && e.iteration === 1);
    expect(vEntry).toBeDefined();
    expect(vEntry?.status).toBe("failed");
    expect(vEntry?.reason).toBe("verify hit error");
  });

  it("non-sentinel failure records reason: null", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false },
        b: { executor: "fake", terminal: true },
      },
      // The successor exists so the run drains rather than failing at a.
      edges: [{ from: "a", to: "b", when: "on_failure" }],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [
        // Exit-code-derived failure with no sentinel reason.
        { kind: "status", status: "failed", meta: { exitCode: 1 } } as NodeEvent,
      ],
      b: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg });
    const prior = exec.contexts.get("b")?.[0]?.priorResults ?? [];
    expect(prior).toHaveLength(1);
    expect(prior[0]?.nodeId).toBe("a");
    expect(prior[0]?.status).toBe("failed");
    expect(prior[0]?.reason).toBeNull();
  });

  it("skipped node (max_iterations hit at pop time) does not append a priorResults entry", async () => {
    // p has max_iterations 1 and fails; on_failure → p again. The second pop
    // hits the budget and is skipped — no priorResults entry should land for
    // that skipped occurrence. b is unreachable on a fail-then-fail-skip path
    // but we still want to assert that only the 1 real execution is appended.
    const factory: Factory = {
      name: "f",
      nodes: {
        p: { executor: "fake", terminal: false, max_iterations: 1 },
        b: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "p", to: "p", when: "on_failure" },
        { from: "p", to: "b", when: "on_success" },
      ],
    };
    const exec = new FakeExecutor("fake", {
      p: () => [failed],
      b: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    // Capture the run's terminal priorResults indirectly: re-dispatch a final
    // node whose ctx captures it. Easiest: have a second start node `s` that
    // runs after p (no edge between them); since both are start nodes the
    // runner schedules them in queue order. Actually simpler — assert via the
    // executor: p was only called once, and the run ended budget_exhausted.
    const result = await runFactory(wrap(factory), { registry: reg });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("budget_exhausted");
    expect(exec.contexts.get("p")?.length).toBe(1);
    // Re-run with a probe: add a synthetic terminal "z" reachable from p's
    // on_failure when budget is hit? Not possible. Instead, assert structurally
    // through a second test that the snapshot length matches actual executions.
    // The single execution of p means at most one entry was appended.
    // (Stronger assertion follows in the next test.)
  });

  it("priorResults snapshot length matches actual executions, not queue pops", async () => {
    // Three start nodes: a, b, c. The third's snapshot should be exactly the
    // first two completed entries — no phantom entries from any skipped node.
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false },
        b: { executor: "fake", terminal: false },
        c: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "a", to: "c", when: "on_success" },
        { from: "b", to: "c", when: "on_success" },
      ],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [succeeded],
      b: () => [succeeded],
      c: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg });
    // c may run once or twice depending on enqueue order; check the *first*
    // dispatch's snapshot contains exactly the entries from preceding nodes.
    const cCtxs = exec.contexts.get("c") ?? [];
    expect(cCtxs.length).toBeGreaterThanOrEqual(1);
    const firstC = cCtxs[0];
    const ids = (firstC?.priorResults ?? []).map((e) => e.nodeId);
    expect(ids).toEqual(["a", "b"]);
  });

  it("invokes onEvent for every event in order", async () => {
    const factory: Factory = {
      name: "f",
      nodes: { a: { executor: "fake", terminal: true } },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [{ kind: "stdout", line: "x" }, { kind: "stdout", line: "y" }, succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const seen: EmittedEvent[] = [];
    await runFactory(wrap(factory), {
      registry: reg,
      onEvent: (e) => seen.push(e),
    });
    expect(seen.map((s) => s.event)).toEqual([
      { kind: "stdout", line: "x" },
      { kind: "stdout", line: "y" },
      succeeded,
    ]);
  });

  it("resolves cwd: absolute is preserved, relative resolves against sourceDir, absent defaults to sourceDir", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: false, cwd: "/abs/dir" },
        b: { executor: "fake", terminal: false, cwd: "./rel" },
        c: { executor: "fake", terminal: true },
      },
      edges: [
        { from: "a", to: "b", when: "on_success" },
        { from: "b", to: "c", when: "on_success" },
      ],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [succeeded],
      b: () => [succeeded],
      c: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory, "/factories/here"), { registry: reg });
    expect(exec.contexts.get("a")?.[0]?.cwd).toBe("/abs/dir");
    expect(exec.contexts.get("b")?.[0]?.cwd).toBe(path.resolve("/factories/here", "./rel"));
    expect(exec.contexts.get("c")?.[0]?.cwd).toBe("/factories/here");
  });

  it("fails with unknown_executor when no executor is registered for a node", async () => {
    const factory: Factory = {
      name: "f",
      nodes: { a: { executor: "missing", terminal: true } },
      edges: [],
    };
    const reg = new ExecutorRegistry();
    const result = await runFactory(wrap(factory), { registry: reg });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("unknown_executor");
    expect(result.proximateNodeId).toBe("a");
  });

  it("substitutes brief tokens in `with.prompt` before dispatch when a brief is in scope", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: {
          executor: "fake",
          terminal: true,
          with: { prompt: "Work on {{ brief.change }}.\n\n{{ brief.body }}" },
        },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const brief: Brief = {
      frontmatter: { change: "foo", factory: "sdd" },
      body: "intent paragraph",
      sourcePath: "/inputs/foo.md",
    };
    await runFactory(wrap(factory), { registry: reg, brief });
    const node = exec.nodes.get("a")?.[0];
    expect(node?.with?.prompt).toBe("Work on foo.\n\nintent paragraph");
  });

  it("does not mutate the factory's node when substituting", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: {
          executor: "fake",
          terminal: true,
          with: { prompt: "Hello {{ brief.change }}." },
        },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const brief: Brief = {
      frontmatter: { change: "foo", factory: "sdd" },
      body: "",
      sourcePath: "/inputs/foo.md",
    };
    await runFactory(wrap(factory), { registry: reg, brief });
    expect(factory.nodes.a?.with?.prompt).toBe("Hello {{ brief.change }}.");
  });

  it("substitutes {{ run.cwd }} in node.cwd when runCwd is supplied", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: true, cwd: "{{ run.cwd }}" },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory, "/factories/here"), {
      registry: reg,
      runCwd: "/wt/some-change",
    });
    expect(exec.contexts.get("a")?.[0]?.cwd).toBe("/wt/some-change");
  });

  it("substitutes {{ run.cwd }} in with.prompt when runCwd is supplied", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: {
          executor: "fake",
          terminal: true,
          with: { prompt: "cd {{ run.cwd }}" },
        },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg, runCwd: "/wt/x" });
    const node = exec.nodes.get("a")?.[0];
    expect(node?.with?.prompt).toBe("cd /wt/x");
  });

  it("literal cwd takes precedence over runCwd", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: true, cwd: "/explicit" },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg, runCwd: "/wt" });
    expect(exec.contexts.get("a")?.[0]?.cwd).toBe("/explicit");
  });

  it("missing cwd falls back to runCwd (not sourceDir) when runCwd is in scope", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: true },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory, "/factories/here"), {
      registry: reg,
      runCwd: "/wt/x",
    });
    expect(exec.contexts.get("a")?.[0]?.cwd).toBe("/wt/x");
  });

  it("with no runCwd, behavior matches today's contract", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: { executor: "fake", terminal: true, cwd: "{{ run.cwd }}" },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory, "/factories/here"), { registry: reg });
    // No runCwd in scope → token passes through verbatim → falls into the
    // relative-path resolver against sourceDir.
    const cwd = exec.contexts.get("a")?.[0]?.cwd;
    // Effectively `/factories/here/{{ run.cwd }}` as a literal — exact path
    // depends on `path.resolve`. Assert it contains the literal token (which
    // proves the no-runCwd path matched pass-through).
    expect(cwd).toContain("{{ run.cwd }}");
  });

  it("substitutes both with.prompt and cwd in a single run", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: {
          executor: "fake",
          terminal: true,
          cwd: "{{ run.cwd }}",
          with: { prompt: "Hello {{ brief.change }} in {{ run.cwd }}." },
        },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const brief: Brief = {
      frontmatter: { change: "foo", factory: "sdd" },
      body: "",
      sourcePath: "/x.md",
    };
    await runFactory(wrap(factory), { registry: reg, brief, runCwd: "/wt/foo" });
    expect(exec.contexts.get("a")?.[0]?.cwd).toBe("/wt/foo");
    expect(exec.nodes.get("a")?.[0]?.with?.prompt).toBe("Hello foo in /wt/foo.");
  });

  it("leaves tokens verbatim when no brief is supplied", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: {
          executor: "fake",
          terminal: true,
          with: { prompt: "Work on {{ brief.change }}." },
        },
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", { a: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg });
    const node = exec.nodes.get("a")?.[0];
    expect(node?.with?.prompt).toBe("Work on {{ brief.change }}.");
  });

  describe("with a RunStore", () => {
    function singleSuccess(): { factory: Factory; reg: ExecutorRegistry; exec: FakeExecutor } {
      const factory: Factory = {
        name: "f",
        nodes: { a: { executor: "fake", terminal: true } },
        edges: [],
      };
      const exec = new FakeExecutor("fake", {
        a: () => [{ kind: "stdout", line: "x" }, { kind: "stdout", line: "y" }, succeeded],
      });
      const reg = new ExecutorRegistry();
      reg.register(exec);
      return { factory, reg, exec };
    }

    it("createRun then finalizeRun bracket the run", async () => {
      const store = new FakeStore();
      const { factory, reg } = singleSuccess();
      await runFactory(wrap(factory), { registry: reg, store, runId: "r1" });
      expect(store.runs.get("r1")?.status).toBe("succeeded");
      expect(store.finalizeCalls).toHaveLength(1);
      expect(store.finalizeCalls[0]?.input.status).toBe("succeeded");
    });

    it("appendEvent fires once per emitted event in order", async () => {
      const store = new FakeStore();
      const { factory, reg } = singleSuccess();
      await runFactory(wrap(factory), { registry: reg, store, runId: "r1" });
      const events = store.events.get("r1") ?? [];
      expect(events.map((e) => e.kind)).toEqual(["stdout", "stdout", "status"]);
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    });

    it("records brief change/path when a brief is in scope", async () => {
      const store = new FakeStore();
      const { factory, reg } = singleSuccess();
      const brief: Brief = {
        frontmatter: { change: "mychange", factory: "f", base_branch: "main" },
        body: "",
        sourcePath: "/inputs/mychange.md",
      };
      await runFactory(wrap(factory), { registry: reg, store, runId: "r1", brief });
      const r = store.runs.get("r1");
      expect(r?.change).toBe("mychange");
      expect(r?.briefPath).toBe("/inputs/mychange.md");
      expect(r?.baseBranch).toBe("main");
    });

    it("brief-less run leaves change/briefPath null", async () => {
      const store = new FakeStore();
      const { factory, reg } = singleSuccess();
      await runFactory(wrap(factory), { registry: reg, store, runId: "r1" });
      const r = store.runs.get("r1");
      expect(r?.change).toBeNull();
      expect(r?.briefPath).toBeNull();
      expect(r?.factoryName).toBe("f");
    });

    it("budget-exhausted run finalizes with budget_exhausted reason", async () => {
      const store = new FakeStore();
      const factory: Factory = {
        name: "f",
        nodes: {
          a: { executor: "fake", terminal: false, max_iterations: 2 },
          t: { executor: "fake", terminal: true },
        },
        edges: [
          { from: "a", to: "a", when: "on_failure" },
          { from: "a", to: "t", when: "on_success" },
        ],
      };
      const exec = new FakeExecutor("fake", {
        a: () => [failed],
        t: () => [succeeded],
      });
      const reg = new ExecutorRegistry();
      reg.register(exec);
      await runFactory(wrap(factory), { registry: reg, store, runId: "r1" });
      expect(store.runs.get("r1")?.status).toBe("failed");
      expect(store.runs.get("r1")?.reason).toBe("budget_exhausted");
    });

    it("node_failed reason flows to finalize", async () => {
      const store = new FakeStore();
      const factory: Factory = {
        name: "f",
        nodes: { a: { executor: "fake", terminal: true } },
        edges: [],
      };
      const exec = new FakeExecutor("fake", { a: () => [failed] });
      const reg = new ExecutorRegistry();
      reg.register(exec);
      await runFactory(wrap(factory), { registry: reg, store, runId: "r1" });
      const r = store.runs.get("r1");
      expect(r?.status).toBe("failed");
      expect(r?.reason).toBe("node_failed");
      expect(r?.proximateNodeId).toBe("a");
    });

    it("store optional: store-less run still works", async () => {
      const { factory, reg } = singleSuccess();
      const result = await runFactory(wrap(factory), { registry: reg });
      expect(result.status).toBe("succeeded");
    });

    it("recordNodeStart/End brackets each dispatch", async () => {
      const store = new FakeStore();
      const { factory, reg } = singleSuccess();
      await runFactory(wrap(factory), { registry: reg, store, runId: "r1" });
      expect(store.nodeStarts).toHaveLength(1);
      expect(store.nodeStarts[0]?.nodeId).toBe("a");
      expect(store.nodeEnds).toHaveLength(1);
      expect(store.nodeEnds[0]?.end.status).toBe("succeeded");
    });
  });

  describe("mark-done post-step", () => {
    function trivialSuccess(): { factory: Factory; reg: ExecutorRegistry } {
      const factory: Factory = {
        name: "f",
        nodes: { a: { executor: "fake", terminal: true } },
        edges: [],
      };
      const exec = new FakeExecutor("fake", { a: () => [succeeded] });
      const reg = new ExecutorRegistry();
      reg.register(exec);
      return { factory, reg };
    }

    // Lazy imports to avoid pulling node:child_process into the rest of the
    // suite when not needed.
    async function makeGitRepo(): Promise<string> {
      const { spawnSync } = await import("node:child_process");
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const pathMod = await import("node:path");
      const dir = await mkdtemp(pathMod.join(tmpdir(), "minifac-runner-md-"));
      const sh = (args: string[]): void => {
        const r = spawnSync(args[0] as string, args.slice(1), { cwd: dir, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr}`);
      };
      sh(["git", "init", "-q", "-b", "main"]);
      sh(["git", "config", "user.email", "test@example.com"]);
      sh(["git", "config", "user.name", "Test"]);
      sh(["git", "config", "commit.gpgsign", "false"]);
      sh(["git", "config", "core.hooksPath", "/dev/null"]);
      await writeFile(pathMod.join(dir, "README.md"), "hi\n");
      sh(["git", "add", "."]);
      sh(["git", "commit", "-q", "-m", "init"]);
      return dir;
    }

    function briefFor(change: string): Brief {
      return {
        frontmatter: { change, factory: "sdd", depends_on: [] } as Brief["frontmatter"],
        body: "body",
        sourcePath: `/fake/inputs/${change}.md`,
      };
    }

    it("moves the brief to inputs/done/ on terminal success", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const pathMod = await import("node:path");
      const { spawnSync } = await import("node:child_process");
      const repo = await makeGitRepo();
      await mkdir(pathMod.join(repo, "inputs"), { recursive: true });
      await writeFile(
        pathMod.join(repo, "inputs", "foo.md"),
        "---\nchange: foo\nfactory: sdd\n---\nbody\n",
      );
      const sh = (args: string[]): void => {
        const r = spawnSync(args[0] as string, args.slice(1), { cwd: repo, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr}`);
      };
      sh(["git", "add", "."]);
      sh(["git", "commit", "-q", "-m", "add brief"]);

      const { factory, reg } = trivialSuccess();
      const result = await runFactory(wrap(factory), {
        registry: reg,
        brief: briefFor("foo"),
        runCwd: repo,
      });
      expect(result.status).toBe("succeeded");
      expect(existsSync(pathMod.join(repo, "inputs", "foo.md"))).toBe(false);
      expect(existsSync(pathMod.join(repo, "inputs", "done", "foo.md"))).toBe(true);
    });

    it("does NOT invoke mark-done on failure", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const pathMod = await import("node:path");
      const { spawnSync } = await import("node:child_process");
      const repo = await makeGitRepo();
      await mkdir(pathMod.join(repo, "inputs"), { recursive: true });
      await writeFile(
        pathMod.join(repo, "inputs", "foo.md"),
        "---\nchange: foo\nfactory: sdd\n---\nbody\n",
      );
      const sh = (args: string[]): void => {
        const r = spawnSync(args[0] as string, args.slice(1), { cwd: repo, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr}`);
      };
      sh(["git", "add", "."]);
      sh(["git", "commit", "-q", "-m", "add brief"]);

      const factory: Factory = {
        name: "f",
        nodes: { a: { executor: "fake", terminal: true } },
        edges: [],
      };
      const exec = new FakeExecutor("fake", { a: () => [failed] });
      const reg = new ExecutorRegistry();
      reg.register(exec);
      const result = await runFactory(wrap(factory), {
        registry: reg,
        brief: briefFor("foo"),
        runCwd: repo,
      });
      expect(result.status).toBe("failed");
      expect(existsSync(pathMod.join(repo, "inputs", "foo.md"))).toBe(true);
      expect(existsSync(pathMod.join(repo, "inputs", "done", "foo.md"))).toBe(false);
    });

    it("does NOT invoke mark-done for brief-less runs", async () => {
      const { existsSync } = await import("node:fs");
      const pathMod = await import("node:path");
      const repo = await makeGitRepo();
      const { factory, reg } = trivialSuccess();
      const result = await runFactory(wrap(factory), {
        registry: reg,
        runCwd: repo,
      });
      expect(result.status).toBe("succeeded");
      // No inputs/done/ ever created.
      expect(existsSync(pathMod.join(repo, "inputs", "done"))).toBe(false);
    });

    it("with skipMarkDone:true does NOT move the brief; runs row still succeeds", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const pathMod = await import("node:path");
      const { spawnSync } = await import("node:child_process");
      const repo = await makeGitRepo();
      await mkdir(pathMod.join(repo, "inputs"), { recursive: true });
      await writeFile(
        pathMod.join(repo, "inputs", "foo.md"),
        "---\nchange: foo\nfactory: sdd\n---\nbody\n",
      );
      const sh = (args: string[]): void => {
        const r = spawnSync(args[0] as string, args.slice(1), { cwd: repo, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr}`);
      };
      sh(["git", "add", "."]);
      sh(["git", "commit", "-q", "-m", "add brief"]);

      const { factory, reg } = trivialSuccess();
      const store = new FakeStore();
      const warnings: string[] = [];
      const result = await runFactory(wrap(factory), {
        registry: reg,
        brief: briefFor("foo"),
        runCwd: repo,
        store,
        runId: "r1",
        skipMarkDone: true,
        onEvent: (e) => {
          if (e.nodeId === "__mark_done__" && e.event.kind === "stderr") {
            warnings.push(e.event.line);
          }
        },
      });
      expect(result.status).toBe("succeeded");
      // Brief stays put.
      expect(existsSync(pathMod.join(repo, "inputs", "foo.md"))).toBe(true);
      expect(existsSync(pathMod.join(repo, "inputs", "done", "foo.md"))).toBe(false);
      // No mark-done warning either way.
      expect(warnings).toEqual([]);
      // Runs row still finalized succeeded.
      expect(store.runs.get("r1")?.status).toBe("succeeded");
    });

    it("with skipMarkDone unset/false still moves the brief (regression)", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const pathMod = await import("node:path");
      const { spawnSync } = await import("node:child_process");
      const repo = await makeGitRepo();
      await mkdir(pathMod.join(repo, "inputs"), { recursive: true });
      await writeFile(
        pathMod.join(repo, "inputs", "bar.md"),
        "---\nchange: bar\nfactory: sdd\n---\nbody\n",
      );
      const sh = (args: string[]): void => {
        const r = spawnSync(args[0] as string, args.slice(1), { cwd: repo, encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr}`);
      };
      sh(["git", "add", "."]);
      sh(["git", "commit", "-q", "-m", "add brief"]);

      const { factory, reg } = trivialSuccess();
      const result = await runFactory(wrap(factory), {
        registry: reg,
        brief: briefFor("bar"),
        runCwd: repo,
        skipMarkDone: false,
      });
      expect(result.status).toBe("succeeded");
      expect(existsSync(pathMod.join(repo, "inputs", "bar.md"))).toBe(false);
      expect(existsSync(pathMod.join(repo, "inputs", "done", "bar.md"))).toBe(true);
    });

    it("logs a warning and still succeeds when git mv fails", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const repo = await makeGitRepo();
      // Write the brief but do NOT add/commit it — `git mv` refuses untracked.
      await mkdir(pathMod.join(repo, "inputs"), { recursive: true });
      await writeFile(
        pathMod.join(repo, "inputs", "foo.md"),
        "---\nchange: foo\nfactory: sdd\n---\nbody\n",
      );

      const { factory, reg } = trivialSuccess();
      const warnings: string[] = [];
      const result = await runFactory(wrap(factory), {
        registry: reg,
        brief: briefFor("foo"),
        runCwd: repo,
        onEvent: (e) => {
          if (e.nodeId === "__mark_done__" && e.event.kind === "stderr") {
            warnings.push(e.event.line);
          }
        },
      });
      expect(result.status).toBe("succeeded");
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toMatch(/mark-done/);
    });
  });
});

describe("runFactory — outputs directory and validation", () => {
  // Note: these tests touch the real `MINIFAC_HOME` path, but only under
  // a per-test tmpdir override so they don't pollute the user's state.
  let savedHome: string | undefined;
  let homeDir: string | undefined;

  beforeEach(async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    savedHome = process.env.MINIFAC_HOME;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "minifac-outputs-test-"));
    process.env.MINIFAC_HOME = homeDir;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      Reflect.deleteProperty(process.env, "MINIFAC_HOME");
    } else {
      process.env.MINIFAC_HOME = savedHome;
    }
  });

  function makeNode(over: Partial<Factory["nodes"][string]> = {}) {
    return {
      executor: "fake",
      terminal: true,
      ...over,
    } as Factory["nodes"][string];
  }

  it("creates the per-iteration outputs directory before dispatch", async () => {
    const fs = await import("node:fs/promises");
    let seenDir: string | null = null;
    const factory: Factory = {
      name: "f",
      nodes: { a: makeNode({}) },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        seenDir = ctx.outputsDir;
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "run-abc" });
    expect(res.status).toBe("succeeded");
    expect(seenDir).toBe(path.join(homeDir as string, "outputs", "run-abc", "a", "1"));
    // The directory exists by the time the executor saw it; verify now.
    const stat = await fs.stat(seenDir as unknown as string);
    expect(stat.isDirectory()).toBe(true);
  });

  it("substitutes `{{ run.outputs_dir }}` in the node prompt", async () => {
    let prompt: string | undefined;
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({ with: { prompt: "Write to {{ run.outputs_dir }}/findings.json" } }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (_ctx, node) => {
        prompt = node.with?.prompt as string;
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(prompt).toBe(
      `Write to ${path.join(homeDir as string, "outputs", "rid", "a", "1")}/findings.json`,
    );
  });

  it("required value output absent overrides succeed -> failed", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    // terminal:true on `a` so the run would otherwise succeed; but missing
    // required output flips the node and the overall run to failed.
    expect(res.status).toBe("failed");
    expect(res.reason).toBe("node_failed");
  });

  it("required value output present and parseable keeps succeeded", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        writeFileSync(path.join(ctx.outputsDir, "findings.json"), JSON.stringify({ ok: true }));
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(res.status).toBe("succeeded");
  });

  it("required value output present but unparseable fails", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        writeFileSync(path.join(ctx.outputsDir, "findings.json"), "not json{");
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(res.status).toBe("failed");
  });

  it("required file output without filename uses glob discovery", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { patch: { type: "file", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        writeFileSync(path.join(ctx.outputsDir, "patch.diff"), "--- a\n+++ b\n");
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(res.status).toBe("succeeded");
  });

  it("ambiguous file output glob fails the node", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { patch: { type: "file", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        writeFileSync(path.join(ctx.outputsDir, "patch.diff"), "a");
        writeFileSync(path.join(ctx.outputsDir, "patch.txt"), "b");
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(res.status).toBe("failed");
  });

  it("empty directory output fails when required", async () => {
    const { mkdirSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { logs: { type: "directory", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        mkdirSync(path.join(ctx.outputsDir, "logs"), { recursive: true });
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(res.status).toBe("failed");
  });

  it("non-empty directory output passes", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { logs: { type: "directory", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        const logsDir = path.join(ctx.outputsDir, "logs");
        mkdirSync(logsDir, { recursive: true });
        writeFileSync(path.join(logsDir, "log.txt"), "hello");
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(res.status).toBe("succeeded");
  });

  it("sentinel-failed node skips validation, preserves reason and outputs:null", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { results: { type: "value", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [
        {
          kind: "status",
          status: "failed",
          meta: { reason: "sentinel_failed", sentinel: "verify hit error" },
        } as NodeEvent,
      ],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const store = new FakeStore();
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid", store });
    expect(res.status).toBe("failed");
    // Sentinel reason preserved (NOT missing_required_output).
    expect(store.nodeOutputs.length).toBe(0);
  });

  it("optional output missing does not fail the node", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { notes: { type: "value", required: false } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(res.status).toBe("succeeded");
  });

  it("partial index preserved on missing-required override", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: {
            findings: { type: "value", required: true },
            notes: { type: "value", required: false },
          },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        writeFileSync(path.join(ctx.outputsDir, "notes.json"), JSON.stringify(["a"]));
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const store = new FakeStore();
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid", store });
    expect(res.status).toBe("failed");
    // notes was indexed even though findings was missing.
    expect(store.nodeOutputs.length).toBe(1);
    const recorded = store.nodeOutputs[0];
    if (!recorded) throw new Error("expected one nodeOutputs entry");
    expect(Object.keys(recorded.outputs)).toEqual(["notes"]);
  });

  it("NodeResult.outputs is null when no outputs declared", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({ terminal: false }),
        b: makeNode({}),
      },
      edges: [{ from: "a", to: "b", when: "on_success" }],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [succeeded],
      b: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    const bCtx = exec.contexts.get("b")?.[0];
    expect(bCtx?.priorResults[0]?.outputs).toBeNull();
  });

  it("latest iteration wins for priorResults lookups", async () => {
    const { writeFileSync } = await import("node:fs");
    // The chain: v runs, writes results, succeeds → gate. gate fails first
    // iteration so the runner takes the on_failure edge back to v for a
    // second iteration of v. gate succeeds on iteration 2 → d. d's prompt
    // references priorResults.v.outputs.results, which should resolve to
    // v's iteration-2 path.
    const factory: Factory = {
      name: "f",
      nodes: {
        v: makeNode({
          terminal: false,
          max_iterations: 2,
          outputs: { results: { type: "value", required: true } },
        }),
        gate: makeNode({ terminal: false, max_iterations: 2 }),
        d: makeNode({
          with: { prompt: "{{ priorResults.v.outputs.results }}" },
        }),
      },
      edges: [
        { from: "v", to: "gate", when: "on_success" },
        { from: "gate", to: "v", when: "on_failure", max_traversals: 1 },
        { from: "gate", to: "d", when: "on_success" },
      ],
    };
    let vIter = 0;
    let gateIter = 0;
    const exec = new FakeExecutor("fake", {
      v: (ctx) => {
        vIter += 1;
        writeFileSync(path.join(ctx.outputsDir, "results.json"), JSON.stringify({ iter: vIter }));
        return [succeeded];
      },
      gate: () => {
        gateIter += 1;
        return [gateIter === 1 ? failed : succeeded];
      },
      d: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    const dNode = exec.nodes.get("d")?.[0];
    const seenPrompt = dNode?.with?.prompt as string;
    expect(seenPrompt).toMatch(/\/v\/2\/results\.json$/);
  });

  it("records outputs to the store when satisfied", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: (ctx) => {
        writeFileSync(path.join(ctx.outputsDir, "findings.json"), JSON.stringify({ ok: 1 }));
        return [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const store = new FakeStore();
    await runFactory(wrap(factory), { registry: reg, runId: "rid", store });
    expect(store.nodeOutputs.length).toBe(1);
    const entry = store.nodeOutputs[0];
    if (!entry) throw new Error("expected one nodeOutputs entry");
    expect(entry.nodeId).toBe("a");
    expect(entry.iteration).toBe(1);
    expect(entry.outputs.findings?.type).toBe("value");
  });
});

/**
 * Per-turn script for {@link NudgeableExecutor}. Each script returns the
 * events to emit during that turn AND an optional side effect to run
 * before yielding (e.g. writing the missing file to disk during a
 * later turn). The runner observes the stream-json-style `result` line
 * the script ends with — sentinel parsing keys off `result.result`.
 */
interface NudgeTurn {
  /** Side effect to run before yielding the turn's events (e.g. write
   * a file). Receives the dispatch context. */
  before?: (ctx: RunContext) => void | Promise<void>;
  /** The model's final assistant message for the turn. The executor
   * wraps it as a stream-json `result` line so the runner can detect
   * the turn boundary and the sentinel. */
  result: string;
  /** Optional stdout/stderr events to emit before the `result` line. */
  pre?: NodeEvent[];
}

/**
 * Nudge-capable fake executor. Holds the iterator open between turns
 * and waits for either `writeUserMessage` (advance to next turn) or
 * `closeInput` (finalize with the most recent turn's sentinel as the
 * terminal status). Used to exercise the runner's post-execution nudge
 * loop without spawning the real Claude CLI.
 */
class NudgeableExecutor implements NodeExecutor {
  readonly type = "nudgeable";
  readonly supportsMcp = false;
  readonly supportsNudge = true;
  /** Per-node ordered list of turn scripts. Turn N runs after the Nth
   * input (turn 0 runs on initial dispatch; turn 1 after the first
   * `writeUserMessage` call; etc.). */
  scripts: Map<string, NudgeTurn[]>;
  nudgeMessagesReceived: Map<string, string[]> = new Map();
  closeCallsByNode: Map<string, number> = new Map();
  /** Optional write-failure injection: when set for a node id, the
   * first `writeUserMessage` call rejects with the given error. */
  writeRejections: Map<string, Error> = new Map();

  private currentNodeId: string | null = null;
  private pendingResolve: (() => void) | null = null;
  private pendingClose = false;
  private nudgeQueue: string[] = [];

  constructor(scripts: Record<string, NudgeTurn[]>) {
    this.scripts = new Map(Object.entries(scripts));
  }

  async writeUserMessage(msg: string): Promise<void> {
    const nodeId = this.currentNodeId;
    if (!nodeId) throw new Error("writeUserMessage with no active node");
    const reject = this.writeRejections.get(nodeId);
    if (reject) {
      this.writeRejections.delete(nodeId);
      throw reject;
    }
    const list = this.nudgeMessagesReceived.get(nodeId) ?? [];
    list.push(msg);
    this.nudgeMessagesReceived.set(nodeId, list);
    this.nudgeQueue.push(msg);
    this.wake();
  }

  closeInput(): void {
    const nodeId = this.currentNodeId;
    if (nodeId) {
      this.closeCallsByNode.set(nodeId, (this.closeCallsByNode.get(nodeId) ?? 0) + 1);
    }
    this.pendingClose = true;
    this.wake();
  }

  private wake(): void {
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r();
    }
  }

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    this.currentNodeId = node.id;
    this.pendingClose = false;
    this.nudgeQueue = [];
    const turns = this.scripts.get(node.id) ?? [];
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (!turn) break;
      if (turn.before) await turn.before(ctx);
      if (turn.pre) {
        for (const evt of turn.pre) yield evt;
      }
      // Emit the `result` line as a stdout event — the runner parses
      // it for turn boundaries.
      const resultLine = JSON.stringify({ type: "result", result: turn.result });
      yield { kind: "stdout", line: resultLine };
      // Wait for next input or close.
      if (i + 1 < turns.length) {
        await this.waitForInput();
        if (this.pendingClose) break;
      } else {
        // No more turns; wait for closeInput.
        await this.waitForInput();
      }
    }
    // Synthesize a final status: use the LAST emitted result's sentinel.
    const lastTurn = turns[turns.length - 1];
    if (lastTurn) {
      const SENTINEL =
        /^MINIFAC_STATUS:[ \t]*(succeeded|failed)\b[ \t]*(?:\r?\nREASON:[ \t]*(.*))?/m;
      const m = lastTurn.result.match(SENTINEL);
      if (m) {
        if (m[1] === "failed") {
          yield {
            kind: "status",
            status: "failed",
            meta: { reason: "sentinel_failed", sentinel: m[2] },
          };
        } else {
          yield { kind: "status", status: "succeeded", meta: { reason: "sentinel_succeeded" } };
        }
      } else {
        yield { kind: "status", status: "succeeded" };
      }
    } else {
      yield { kind: "status", status: "failed" };
    }
    this.currentNodeId = null;
  }

  private async waitForInput(): Promise<void> {
    if (this.pendingClose) return;
    if (this.nudgeQueue.length > 0) {
      this.nudgeQueue.shift();
      return;
    }
    await new Promise<void>((resolve) => {
      this.pendingResolve = resolve;
    });
    if (this.nudgeQueue.length > 0) this.nudgeQueue.shift();
  }
}

describe("runFactory — post-execution nudge loop", () => {
  let savedHome: string | undefined;
  let homeDir: string | undefined;

  beforeEach(async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    savedHome = process.env.MINIFAC_HOME;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "minifac-nudge-test-"));
    process.env.MINIFAC_HOME = homeDir;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      Reflect.deleteProperty(process.env, "MINIFAC_HOME");
    } else {
      process.env.MINIFAC_HOME = savedHome;
    }
  });

  function makeNode(over: Partial<Factory["nodes"][string]> = {}) {
    return {
      executor: "nudgeable",
      terminal: true,
      ...over,
    } as Factory["nodes"][string];
  }

  it("default budget recovers a forgotten output (nudges_used: 1)", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [
        { result: "I'm done.\nMINIFAC_STATUS: succeeded" },
        {
          before: (ctx) => {
            writeFileSync(path.join(ctx.outputsDir, "findings.json"), JSON.stringify({ ok: true }));
          },
          result: "Wrote it.\nMINIFAC_STATUS: succeeded",
        },
      ],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("succeeded");
    expect(exec.nudgeMessagesReceived.get("a")?.length).toBe(1);
    const actionEvents = events.filter((e) => e.event.kind === "runner-action");
    const nudgeEvents = events.filter((e) => e.event.kind === "runner-nudge");
    expect(actionEvents).toHaveLength(1);
    expect(nudgeEvents).toHaveLength(1);
  });

  it("default budget exhausted records missing_required_output (nudges_used: 1)", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [
        { result: "Done.\nMINIFAC_STATUS: succeeded" },
        // Second turn also doesn't write the file.
        { result: "Still done.\nMINIFAC_STATUS: succeeded" },
      ],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("failed");
    expect(exec.nudgeMessagesReceived.get("a")?.length).toBe(1);
    const overrideStatus = events
      .filter((e) => e.event.kind === "status")
      .map((e) => e.event)
      .find(
        (ev) =>
          ev.kind === "status" &&
          ev.status === "failed" &&
          (ev.meta as { reason?: string } | undefined)?.reason === "missing_required_output",
      );
    expect(overrideStatus).toBeDefined();
    const meta = (overrideStatus as { meta: { nudges_used?: number } }).meta;
    expect(meta.nudges_used).toBe(1);
  });

  it("budget 0 opts out: immediate failed, nudges_used 0, no nudge events", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 0,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [{ result: "Done.\nMINIFAC_STATUS: succeeded" }],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("failed");
    expect(exec.nudgeMessagesReceived.get("a")).toBeUndefined();
    expect(events.find((e) => e.event.kind === "runner-action")).toBeUndefined();
    expect(events.find((e) => e.event.kind === "runner-nudge")).toBeUndefined();
  });

  it("sentinel-failed node skips the nudge loop entirely", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [
        {
          result: "Could not complete.\nMINIFAC_STATUS: failed\nREASON: verify hit 3 test failures",
        },
      ],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("failed");
    expect(exec.nudgeMessagesReceived.get("a")).toBeUndefined();
    expect(events.find((e) => e.event.kind === "runner-action")).toBeUndefined();
  });

  it("first-try success with valid outputs: no nudge fired", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [
        {
          before: (ctx) => {
            writeFileSync(path.join(ctx.outputsDir, "findings.json"), JSON.stringify({ ok: true }));
          },
          result: "Done.\nMINIFAC_STATUS: succeeded",
        },
      ],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("succeeded");
    expect(exec.nudgeMessagesReceived.get("a")).toBeUndefined();
    expect(events.find((e) => e.event.kind === "runner-action")).toBeUndefined();
  });

  it("budget 3 with two nudges needed: two nudges sent, third turn succeeds", async () => {
    const { writeFileSync } = await import("node:fs");
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 3,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [
        { result: "Turn 1 done.\nMINIFAC_STATUS: succeeded" },
        { result: "Turn 2 done.\nMINIFAC_STATUS: succeeded" },
        {
          before: (ctx) => {
            writeFileSync(path.join(ctx.outputsDir, "findings.json"), JSON.stringify({ ok: true }));
          },
          result: "Turn 3 done.\nMINIFAC_STATUS: succeeded",
        },
      ],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("succeeded");
    expect(exec.nudgeMessagesReceived.get("a")?.length).toBe(2);
    expect(events.filter((e) => e.event.kind === "runner-action")).toHaveLength(2);
    expect(events.filter((e) => e.event.kind === "runner-nudge")).toHaveLength(2);
  });

  it("broken stdin during nudge fails the node immediately (nudges_used: 0)", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [
        { result: "Done.\nMINIFAC_STATUS: succeeded" },
        // Second turn won't actually run — the write rejects.
        { result: "should not see this turn.\nMINIFAC_STATUS: succeeded" },
      ],
    });
    const epipe = new Error("EPIPE");
    (epipe as NodeJS.ErrnoException).code = "EPIPE";
    exec.writeRejections.set("a", epipe);
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("failed");
    const overrideStatus = events
      .filter((e) => e.event.kind === "status")
      .map((e) => e.event)
      .find(
        (ev) =>
          ev.kind === "status" &&
          ev.status === "failed" &&
          (ev.meta as { reason?: string } | undefined)?.reason === "missing_required_output",
      );
    expect(overrideStatus).toBeDefined();
    const meta = (
      overrideStatus as {
        meta: { nudges_used?: number; missing_outputs_detail?: Record<string, string> };
      }
    ).meta;
    expect(meta.nudges_used).toBe(0);
    const detail = meta.missing_outputs_detail?.findings ?? "";
    expect(detail).toMatch(/nudge stdin write failed/);
    expect(detail).toMatch(/EPIPE/);
  });

  it("runner-action and runner-nudge events carry nodeId and iteration", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [
        { result: "Done.\nMINIFAC_STATUS: succeeded" },
        { result: "Still nothing.\nMINIFAC_STATUS: succeeded" },
      ],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    const action = events.find((e) => e.event.kind === "runner-action");
    const nudge = events.find((e) => e.event.kind === "runner-nudge");
    expect(action?.nodeId).toBe("a");
    expect(action?.iteration).toBe(1);
    expect(nudge?.nodeId).toBe("a");
    expect(nudge?.iteration).toBe(1);
    // Order: action precedes nudge
    const aIdx = events.findIndex((e) => e.event.kind === "runner-action");
    const nIdx = events.findIndex((e) => e.event.kind === "runner-nudge");
    expect(aIdx).toBeLessThan(nIdx);
  });

  it("nudge events are persisted via the store hook", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
        }),
      },
      edges: [],
    };
    const exec = new NudgeableExecutor({
      a: [
        { result: "Done.\nMINIFAC_STATUS: succeeded" },
        { result: "Still nothing.\nMINIFAC_STATUS: succeeded" },
      ],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const store = new FakeStore();
    await runFactory(wrap(factory), { registry: reg, runId: "rid", store });
    const stored = store.events.get("rid") ?? [];
    const actionRows = stored.filter((s) => s.kind === "runner-action");
    const nudgeRows = stored.filter((s) => s.kind === "runner-nudge");
    expect(actionRows.length).toBe(1);
    expect(nudgeRows.length).toBe(1);
    // Action precedes nudge in the persisted stream.
    expect((actionRows[0]?.seq ?? -1) < (nudgeRows[0]?.seq ?? -1)).toBe(true);
  });

  it("non-nudge-capable executor skips the loop even with budget > 0", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          executor: "fake",
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
        }),
      },
      edges: [],
    };
    const exec = new FakeExecutor("fake", {
      a: () => [succeeded],
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("failed");
    expect(events.find((e) => e.event.kind === "runner-action")).toBeUndefined();
    expect(events.find((e) => e.event.kind === "runner-nudge")).toBeUndefined();
  });

  it("iteration boundary resets the nudge budget", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        a: makeNode({
          terminal: false,
          outputs: { findings: { type: "value", required: true } },
          output_nudge_budget: 1,
          max_iterations: 2,
        }),
        t: makeNode({ executor: "fake", terminal: true }),
      },
      edges: [
        { from: "a", to: "a", when: "on_failure", max_traversals: 1 },
        { from: "a", to: "t", when: "on_success" },
      ],
    };
    const { writeFileSync } = await import("node:fs");
    // Two iterations of `a`: first fails (budget consumed), then a graph-level
    // recovery edge re-dispatches with a fresh budget; iter-2 nudges and
    // recovers.
    const exec = new NudgeableExecutor({
      a: [
        // Iteration 1: turn 1 doesn't write; turn 2 (after nudge) also doesn't.
        // We bake 4 turns into the script and the executor's per-dispatch
        // counter resets per dispatch in run(); but the same NudgeableExecutor
        // instance is re-used for iter-2. So we need iter-2 turns to follow.
        // Use a separate executor instance per iteration would be cleaner, but
        // for this test we'll just verify iter-2 nudges.
        { result: "Iter1 turn1.\nMINIFAC_STATUS: succeeded" },
        { result: "Iter1 turn2.\nMINIFAC_STATUS: succeeded" },
      ],
    });
    // Rebuild scripts for second iteration: after the first dispatch the
    // executor's run() restarts when called again — but currentNodeId is
    // tied to the live dispatch. The scripts map is keyed by node id. To
    // support multiple iterations of the same node, we extend the script
    // length and rely on the executor restarting from the beginning. Since
    // each `run()` call starts at i=0 it WILL replay turns. For an honest
    // test, we patch the scripts after iter-1 completes.
    const fakeExec = new FakeExecutor("fake", { t: () => [succeeded] });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    reg.register(fakeExec);
    // Run the factory. Iteration 1 should consume one nudge then fail.
    // The on_failure edge re-dispatches a; second time, the model writes the
    // file on turn 2.
    // To make iter-2 produce the file, swap the scripts midway via a
    // hand-rolled wrapper: override `before` on the second-turn entry to
    // also write the file ONLY after iter-1 has already happened.
    let dispatchCount = 0;
    const orig = exec.run.bind(exec);
    exec.run = async function* (node, ctx) {
      dispatchCount += 1;
      if (dispatchCount === 2) {
        // For iteration 2's turn-2, write the file.
        const turns = exec.scripts.get("a");
        if (turns?.[1]) {
          turns[1] = {
            before: (c) => {
              writeFileSync(path.join(c.outputsDir, "findings.json"), JSON.stringify({ ok: true }));
            },
            result: "Iter2 turn2 wrote file.\nMINIFAC_STATUS: succeeded",
          };
        }
      }
      yield* orig(node, ctx);
    };
    const events: EmittedEvent[] = [];
    const res = await runFactory(wrap(factory), {
      registry: reg,
      runId: "rid",
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe("succeeded");
    // Each iteration's dispatch consumed at most its own budget (1). Iter-1
    // spent its nudge and failed; iter-2 spent its nudge and recovered.
    expect(exec.nudgeMessagesReceived.get("a")?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
