import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../executor/registry.js";
import type {
  NodeEvent,
  NodeExecutor,
  NodeResult,
  ResolvedNode,
  RunContext,
} from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { Factory } from "../factory/schema.js";
import { HUMAN_ANSWER_HEADING } from "./resume.js";
import { runFactory } from "./run.js";

const succeeded: NodeEvent = { kind: "status", status: "succeeded" };
const failed: NodeEvent = { kind: "status", status: "failed" };

class RecordingExecutor implements NodeExecutor {
  readonly type = "fake";
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  readonly supportsResume = false;
  /** (nodeId, iteration, prompt) per dispatch, in dispatch order. */
  dispatches: Array<{ nodeId: string; iteration: number; prompt: string }> = [];

  constructor(private readonly scripts: Record<string, NodeEvent[]>) {}

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    this.dispatches.push({
      nodeId: node.id,
      iteration: ctx.iteration,
      prompt: typeof node.with?.prompt === "string" ? node.with.prompt : "",
    });
    for (const evt of this.scripts[node.id] ?? [succeeded]) yield evt;
  }

  order(): string[] {
    return this.dispatches.map((d) => d.nodeId);
  }
}

function wrap(factory: Factory): LoadedFactory {
  return { factory, sourcePath: "/tmp/factories/f.yaml", sourceDir: "/tmp/factories" };
}

function priorResult(over: Partial<NodeResult> & { nodeId: string }): NodeResult {
  return {
    iteration: 1,
    status: "succeeded",
    reason: null,
    startedAt: 0,
    endedAt: 1,
    outputs: null,
    nudges_used: 0,
    session_id: null,
    ...over,
  };
}

describe("runFactory with resume", () => {
  let dir: string;
  let home: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-resume-"));
    home = process.env.MINIFAC_HOME;
    process.env.MINIFAC_HOME = path.join(dir, "home");
  });

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (home === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = home;
    await rm(dir, { recursive: true, force: true });
  });

  // TS-1 / AC-1
  it("dispatches the resumed node alone and makes prior results readable", async () => {
    const planResultPath = path.join(dir, "plan-result.json");
    await writeFile(planResultPath, '{"approach":"do the thing"}', "utf8");

    const factory: Factory = {
      name: "f",
      nodes: {
        plan: { executor: "fake" },
        implement: { executor: "fake" },
        evaluate: {
          executor: "fake",
          terminal: true,
          with: {
            prompt:
              "plan said: {{ priorResults.plan.outputs.result:read }}\n" +
              "implement ended {{ priorResults.implement.status }}: {{ priorResults.implement.reason }}",
          },
        },
      },
      edges: [
        { from: "plan", to: "implement", when: "on_success" },
        { from: "implement", to: "evaluate", when: "on_success" },
      ],
    };
    const exec = new RecordingExecutor({ evaluate: [succeeded] });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    const result = await runFactory(wrap(factory), {
      registry,
      resume: {
        at: "evaluate",
        priorResults: [
          priorResult({
            nodeId: "plan",
            outputs: {
              result: { type: "value", path: planResultPath, size: 26, mtime: Date.now() },
            },
          }),
          priorResult({ nodeId: "implement", status: "failed", reason: "revise: not yet" }),
        ],
        iterations: { plan: 1, implement: 1 },
      },
    });

    expect(result.status).toBe("succeeded");
    expect(exec.order()).toEqual(["evaluate"]);
    expect(exec.dispatches[0]?.prompt).toContain('{"approach":"do the thing"}');
    expect(exec.dispatches[0]?.prompt).toContain("implement ended failed: revise: not yet");
  });

  it("dispatches no declared start node when resuming at a mid-graph node", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        plan: { executor: "fake", start: true },
        evaluate: { executor: "fake", terminal: true },
      },
      edges: [{ from: "plan", to: "evaluate", when: "on_success" }],
    };
    const exec = new RecordingExecutor({ evaluate: [succeeded] });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    await runFactory(wrap(factory), {
      registry,
      resume: { at: "evaluate", priorResults: [priorResult({ nodeId: "plan" })] },
    });

    expect(exec.order()).toEqual(["evaluate"]);
  });

  // TS-2 / AC-2
  it("exempts the seed from max_iterations and binds the budget again right after", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        evaluate: { executor: "fake", max_iterations: 2 },
        implement: { executor: "fake" },
      },
      edges: [
        // A failing evaluate routes back to implement, which routes back to
        // evaluate — the second traversal is the one the rehydrated budget
        // must refuse.
        { from: "evaluate", to: "implement", when: "on_failure" },
        { from: "implement", to: "evaluate", when: "on_success" },
      ],
    };
    const exec = new RecordingExecutor({ evaluate: [failed], implement: [succeeded] });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    const result = await runFactory(wrap(factory), {
      registry,
      resume: {
        at: "evaluate",
        priorResults: [],
        // Budget already spent: 2 of max 2.
        iterations: { evaluate: 2, implement: 2 },
      },
    });

    // The seed ran (iteration 3), routed to implement, and evaluate was then
    // refused by the rehydrated budget.
    expect(exec.order()).toEqual(["evaluate", "implement"]);
    expect(exec.dispatches[0]?.iteration).toBe(3);
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("budget_exhausted");
  });

  it("spends no max_traversals slot on the seed, so an exhausted-looking edge still fires", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        evaluate: { executor: "fake" },
        rescue: { executor: "fake", terminal: true },
      },
      edges: [{ from: "evaluate", to: "rescue", when: "on_failure", max_traversals: 1 }],
    };
    const exec = new RecordingExecutor({ evaluate: [failed], rescue: [succeeded] });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    const result = await runFactory(wrap(factory), {
      registry,
      resume: { at: "evaluate", priorResults: [], iterations: { evaluate: 1, rescue: 1 } },
    });

    expect(exec.order()).toEqual(["evaluate", "rescue"]);
    expect(result.status).toBe("succeeded");
  });

  // TS-3 / AC-3
  it("delivers the answer as {{ run.feedback }} and as an injected block on the seed only", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        evaluate: {
          executor: "fake",
          max_iterations: 5,
          with: { prompt: "answer was: {{ run.feedback }}" },
        },
        implement: { executor: "fake", with: { prompt: "no token here" } },
      },
      edges: [
        { from: "evaluate", to: "implement", when: "on_failure" },
        { from: "implement", to: "evaluate", when: "on_success" },
      ],
    };
    const exec = new RecordingExecutor({
      evaluate: [failed],
      implement: [succeeded],
    });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    await runFactory(wrap(factory), {
      registry,
      resume: {
        at: "evaluate",
        priorResults: [],
        feedback: "waive AC-13, verify after deploy",
      },
    });

    const [seed, second, third] = exec.dispatches;
    // The token substituted, and the injected block is present.
    expect(seed?.prompt).toContain("answer was: waive AC-13, verify after deploy");
    expect(seed?.prompt).toContain(HUMAN_ANSWER_HEADING);
    expect(seed?.prompt).toContain("waive AC-13, verify after deploy");
    // A node that binds no token still gets the answer, but only through the
    // token for the whole run — the injected block is the SEED's alone.
    expect(second?.nodeId).toBe("implement");
    expect(second?.prompt).not.toContain(HUMAN_ANSWER_HEADING);
    // Iteration 2 of the resumed node: the token still resolves (run-wide),
    // the injected block does not repeat.
    expect(third?.nodeId).toBe("evaluate");
    expect(third?.iteration).toBe(2);
    expect(third?.prompt).toContain("answer was: waive AC-13, verify after deploy");
    expect(third?.prompt).not.toContain(HUMAN_ANSWER_HEADING);
  });

  it("injects the block into a node whose prompt binds no token", async () => {
    const factory: Factory = {
      name: "f",
      nodes: { plan: { executor: "fake", terminal: true, with: { prompt: "plan the work" } } },
      edges: [],
    };
    const exec = new RecordingExecutor({ plan: [succeeded] });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    await runFactory(wrap(factory), {
      registry,
      resume: { at: "plan", priorResults: [], feedback: "the spec rules for the captain" },
    });

    expect(exec.dispatches[0]?.prompt).toContain("plan the work");
    expect(exec.dispatches[0]?.prompt).toContain(HUMAN_ANSWER_HEADING);
    expect(exec.dispatches[0]?.prompt).toContain("the spec rules for the captain");
  });

  it("substitutes {{ run.feedback }} to the empty string on a run with no answer", async () => {
    const factory: Factory = {
      name: "f",
      nodes: { a: { executor: "fake", terminal: true, with: { prompt: "[{{ run.feedback }}]" } } },
      edges: [],
    };
    const exec = new RecordingExecutor({ a: [succeeded] });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    await runFactory(wrap(factory), { registry });

    expect(exec.dispatches[0]?.prompt).toBe("[]");
  });

  // AC-1 refusal
  it("fails with resume_unknown_node and dispatches nothing for an unknown --at", async () => {
    const factory: Factory = {
      name: "f",
      nodes: { a: { executor: "fake", terminal: true } },
      edges: [],
    };
    const exec = new RecordingExecutor({ a: [succeeded] });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    const result = await runFactory(wrap(factory), {
      registry,
      resume: { at: "nope", priorResults: [] },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("resume_unknown_node");
    expect(exec.dispatches).toHaveLength(0);
  });

  it("numbers the seed dispatch n+1 from the iteration count a prior result implies", async () => {
    const factory: Factory = {
      name: "f",
      nodes: { evaluate: { executor: "fake", terminal: true } },
      edges: [],
    };
    const exec = new RecordingExecutor({ evaluate: [succeeded] });
    const registry = new ExecutorRegistry();
    registry.register(exec);

    await runFactory(wrap(factory), {
      registry,
      // No `iterations` map at all: the result's own iteration is the count.
      resume: { at: "evaluate", priorResults: [priorResult({ nodeId: "evaluate", iteration: 3 })] },
    });

    expect(exec.dispatches[0]?.iteration).toBe(4);
  });
});
