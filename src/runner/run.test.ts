import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Brief } from "../brief/loader.js";
import { ExecutorRegistry } from "../executor/registry.js";
import type {
  NodeEvent,
  NodeExecutor,
  ResolvedNode,
  RunContext,
  RunHistoryEntry,
} from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { Factory } from "../factory/schema.js";
import { runFactory } from "./run.js";

type Script = (ctx: RunContext, node: ResolvedNode) => Iterable<NodeEvent>;

class FakeExecutor implements NodeExecutor {
  readonly type: string;
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

  it("accumulates history across nodes, in order, with node/iteration tags", async () => {
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
    // Check b saw both A events
    const ctxB = exec.contexts.get("b")?.[0];
    expect(ctxB).toBeDefined();
    const hist = ctxB?.history ?? [];
    const aEvents = hist.filter((e) => e.nodeId === "a");
    expect(aEvents).toHaveLength(3);
    expect(aEvents[0]?.iteration).toBe(1);
    expect(aEvents[0]?.event).toEqual({ kind: "stdout", line: "a-line-1" });
  });

  it("P on iteration 2 sees P iter-1 events and V iter-1 events", async () => {
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
        return vRuns === 1 ? [{ kind: "stderr", line: "v-fail" }, failed] : [succeeded];
      },
    });
    const reg = new ExecutorRegistry();
    reg.register(exec);
    await runFactory(wrap(factory), { registry: reg });
    const pCtxs = exec.contexts.get("p");
    expect(pCtxs?.length).toBe(2);
    const iter2 = pCtxs?.[1];
    const hist = iter2?.history ?? [];
    // Should contain p iter-1 and v iter-1
    expect(hist.some((h) => h.nodeId === "p" && h.iteration === 1)).toBe(true);
    expect(hist.some((h) => h.nodeId === "v" && h.iteration === 1)).toBe(true);
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
    const seen: RunHistoryEntry[] = [];
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
});
