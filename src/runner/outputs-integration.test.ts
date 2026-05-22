import { mkdtemp, writeFile } from "node:fs/promises";
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
