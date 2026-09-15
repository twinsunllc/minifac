import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode, RunContext } from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { Factory } from "../factory/schema.js";
import { runFactory } from "./run.js";

class WriterExecutor implements NodeExecutor {
  readonly type = "writer";
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  readonly supportsResume = false;
  readonly capturedPrompts = new Map<string, string>();

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    const prompt = (node.with?.prompt as string | undefined) ?? "";
    this.capturedPrompts.set(node.id, prompt);
    if (node.id === "writer") {
      const fs = await import("node:fs");
      fs.writeFileSync(
        path.join(ctx.outputsDir, "findings.json"),
        JSON.stringify({ result: "writer-ran" }),
      );
    }
    yield { kind: "status", status: "succeeded" };
  }
}

function wrap(factory: Factory, sourceDir = "/tmp"): LoadedFactory {
  return {
    factory,
    sourcePath: path.join(sourceDir, "f.yaml"),
    sourceDir,
  };
}

describe("integration: writer → reader via priorResults outputs", () => {
  let savedHome: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    const dir = await mkdtemp(path.join(tmpdir(), "minifac-int-"));
    process.env.MINIFAC_HOME = dir;
  });

  afterEach(() => {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "MINIFAC_HOME");
    else process.env.MINIFAC_HOME = savedHome;
  });

  it("reader receives writer's findings.json contents via :read", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        writer: {
          executor: "writer",
          terminal: false,
          outputs: { findings: { type: "value", required: true } },
        },
        reader: {
          executor: "writer",
          terminal: true,
          with: { prompt: "<<{{ priorResults.writer.outputs.findings:read }}>>" },
        },
      },
      edges: [{ from: "writer", to: "reader", when: "on_success" }],
    };
    const exec = new WriterExecutor();
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid" });
    expect(res.status).toBe("succeeded");
    const readerPrompt = exec.capturedPrompts.get("reader");
    expect(readerPrompt).toBe(`<<${JSON.stringify({ result: "writer-ran" })}>>`);
  });

  it("a uses: node receives a priorResults token passed through its inputs (#33)", async () => {
    const { loadFactory } = await import("../factory/loader.js");
    const repo = await mkdtemp(path.join(tmpdir(), "minifac-int-uses-"));
    await mkdir(path.join(repo, ".minifac", "steps"), { recursive: true });
    await writeFile(
      path.join(repo, ".minifac", "steps", "relay.yaml"),
      `name: relay
version: "1"
executor: writer
inputs:
  findings: { type: string, required: true }
with:
  prompt: "<<{{ inputs.findings }}>>"
`,
    );
    const factoryPath = path.join(repo, "f.yaml");
    await writeFile(
      factoryPath,
      `name: f
nodes:
  writer:
    executor: writer
    outputs:
      findings: { type: value, required: true }
  reader:
    uses: relay
    terminal: true
    inputs:
      findings: "{{ priorResults.writer.outputs.findings:read }}"
edges:
  - { from: writer, to: reader }
`,
    );
    const loaded = await loadFactory(factoryPath, repo);
    expect(loaded.factory.nodes.reader?.with?.prompt).toBe(
      "<<{{ priorResults.writer.outputs.findings:read }}>>",
    );
    const exec = new WriterExecutor();
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(loaded, { registry: reg, runId: "rid-uses" });
    expect(res.status).toBe("succeeded");
    expect(exec.capturedPrompts.get("reader")).toBe(
      `<<${JSON.stringify({ result: "writer-ran" })}>>`,
    );
  });

  it("missing required output overrides writer to failed and reader is NOT scheduled", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        writer: {
          executor: "writer",
          terminal: false,
          // Required findings: writer doesn't write findings.json this time.
          outputs: { findings: { type: "value", required: true } },
        },
        reader: {
          executor: "writer",
          terminal: true,
          with: { prompt: "should-never-run" },
        },
      },
      edges: [{ from: "writer", to: "reader", when: "on_success" }],
    };
    // A bare WriterExecutor that does NOT write findings.json.
    class NoWriteWriter implements NodeExecutor {
      readonly type = "writer";
      readonly supportsMcp = false;
      readonly supportsNudge = false;
      readonly supportsResume = false;
      readonly seen = new Set<string>();
      async *run(node: ResolvedNode): AsyncIterable<NodeEvent> {
        this.seen.add(node.id);
        yield { kind: "status", status: "succeeded" };
      }
    }
    const exec = new NoWriteWriter();
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid-2" });
    expect(res.status).toBe("failed");
    expect(res.reason).toBe("node_failed");
    expect(exec.seen.has("writer")).toBe(true);
    // reader is never scheduled because writer was overridden to failed and
    // the on_success edge does NOT traverse.
    expect(exec.seen.has("reader")).toBe(false);
  });
});

describe("integration: verdict that routes by failing keeps its payload (ADR 0041, #38)", () => {
  let savedHome: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    const dir = await mkdtemp(path.join(tmpdir(), "minifac-int-38-"));
    process.env.MINIFAC_HOME = dir;
  });

  afterEach(() => {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "MINIFAC_HOME");
    else process.env.MINIFAC_HOME = savedHome;
  });

  const revise = {
    verdict: "revise",
    findings: [{ id: "F1", severity: "must", text: "criterion 2 unmet" }],
    criteria_grades: { c1: "pass", c2: "fail" },
    cycle_summary: "one must-fix remains",
  };

  /** evaluate writes result.json then fails on purpose (verdict=revise);
   * implement is reached via on_failure and must see the structured
   * findings, not just the REASON line. */
  class EvaluateExecutor implements NodeExecutor {
    readonly type = "eval";
    readonly supportsMcp = false;
    readonly supportsNudge = false;
    readonly supportsResume = false;
    readonly capturedPrompts = new Map<string, string>();
    readonly capturedPrior = new Map<string, readonly unknown[]>();
    async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
      this.capturedPrompts.set(node.id, (node.with?.prompt as string | undefined) ?? "");
      this.capturedPrior.set(node.id, ctx.priorResults);
      if (node.id === "evaluate") {
        await writeFile(path.join(ctx.outputsDir, "result.json"), JSON.stringify(revise));
        yield {
          kind: "status",
          status: "failed",
          meta: { reason: "sentinel_failed", sentinel: "revise: criterion 2 unmet" },
        };
        return;
      }
      yield { kind: "status", status: "succeeded" };
    }
  }

  it("implement receives evaluate's result.json, status and reason via tokens", async () => {
    const factory: Factory = {
      name: "f",
      nodes: {
        evaluate: {
          executor: "eval",
          terminal: false,
          outputs: { result: { type: "value", required: true } },
        },
        implement: {
          executor: "eval",
          terminal: true,
          with: {
            prompt: [
              "evaluate ended {{ priorResults.evaluate.status }} ({{ priorResults.evaluate.reason }}).",
              "Findings: {{ priorResults.evaluate.outputs.result:read }}",
              "Path: {{ priorResults.evaluate.outputs.result }}",
            ].join("\n"),
          },
        },
      },
      edges: [{ from: "evaluate", to: "implement", when: "on_failure" }],
    };
    const exec = new EvaluateExecutor();
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(wrap(factory), { registry: reg, runId: "rid-38" });
    expect(res.status).toBe("succeeded");
    const prompt = exec.capturedPrompts.get("implement") ?? "";
    const lines = prompt.split("\n");
    expect(lines[0]).toBe("evaluate ended failed (revise: criterion 2 unmet).");
    expect(lines[1]).toBe(`Findings: ${JSON.stringify(revise)}`);
    expect(lines[2]).toMatch(/^Path: .*\/evaluate\/1\/result\.json$/);
    // The preamble snapshot carries the same index, not null.
    const prior = exec.capturedPrior.get("implement") as Array<{
      nodeId: string;
      status: string;
      outputs: Record<string, { type: string }> | null;
    }>;
    expect(prior[0]?.nodeId).toBe("evaluate");
    expect(prior[0]?.status).toBe("failed");
    expect(prior[0]?.outputs?.result?.type).toBe("value");
  });

  it("a uses: node receives the status token through its inputs", async () => {
    const { loadFactory } = await import("../factory/loader.js");
    const repo = await mkdtemp(path.join(tmpdir(), "minifac-int-38-uses-"));
    await mkdir(path.join(repo, ".minifac", "steps"), { recursive: true });
    await writeFile(
      path.join(repo, ".minifac", "steps", "implement.yaml"),
      `name: implement
version: "1"
executor: eval
inputs:
  verdict: { type: string, required: true }
  findings: { type: string, required: true }
with:
  prompt: "verdict={{ inputs.verdict }} findings={{ inputs.findings }}"
`,
    );
    const factoryPath = path.join(repo, "f.yaml");
    await writeFile(
      factoryPath,
      `name: f
nodes:
  evaluate:
    executor: eval
    outputs:
      result: { type: value, required: true }
  implement:
    uses: implement
    terminal: true
    inputs:
      verdict: "{{ priorResults.evaluate.status }}"
      findings: "{{ priorResults.evaluate.outputs.result:read }}"
edges:
  - { from: evaluate, to: implement, when: on_failure }
`,
    );
    const loaded = await loadFactory(factoryPath, repo);
    expect(loaded.factory.nodes.implement?.with?.prompt).toBe(
      "verdict={{ priorResults.evaluate.status }} findings={{ priorResults.evaluate.outputs.result:read }}",
    );
    const exec = new EvaluateExecutor();
    const reg = new ExecutorRegistry();
    reg.register(exec);
    const res = await runFactory(loaded, { registry: reg, runId: "rid-38-uses" });
    expect(res.status).toBe("succeeded");
    expect(exec.capturedPrompts.get("implement")).toBe(
      `verdict=failed findings=${JSON.stringify(revise)}`,
    );
  });
});

describe("integration: existing examples still load and run", () => {
  it("hello.yaml loads (no outputs declared)", async () => {
    const { loadFactory } = await import("../factory/loader.js");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const helloPath = path.join(repoRoot, "examples", "hello.yaml");
    const loaded = await loadFactory(helloPath, repoRoot);
    expect(loaded.factory.name).toBe("hello");
    // No outputs anywhere on the node.
    for (const node of Object.values(loaded.factory.nodes)) {
      expect((node as { outputs?: unknown }).outputs).toBeUndefined();
    }
  });

  it("sdd.yaml loads (no outputs declared)", async () => {
    const { loadFactory } = await import("../factory/loader.js");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const sddPath = path.join(repoRoot, "examples", "sdd.yaml");
    const loaded = await loadFactory(sddPath, repoRoot);
    expect(loaded.factory.name).toBe("sdd");
    for (const node of Object.values(loaded.factory.nodes)) {
      expect((node as { outputs?: unknown }).outputs).toBeUndefined();
    }
  });
});

// Suppress unused import warning for writeFile (kept available for future
// integration tests).
void writeFile;
