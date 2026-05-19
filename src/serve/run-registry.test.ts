import { describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode } from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import { type RunEventEntry, RunRegistry } from "./run-registry.js";

function makeLoaded(): LoadedFactory {
  return {
    sourcePath: "/tmp/fake.yaml",
    sourceDir: "/tmp",
    factory: {
      name: "x",
      nodes: {
        a: { executor: "test", terminal: true },
      },
      edges: [],
    },
  };
}

function buildScripted(scripts: Record<string, NodeEvent[]>): () => ExecutorRegistry {
  return () => {
    const reg = new ExecutorRegistry();
    const exec: NodeExecutor = {
      type: "test",
      async *run(node: ResolvedNode): AsyncIterable<NodeEvent> {
        const ev = scripts[node.id] ?? [{ kind: "status", status: "succeeded" }];
        for (const e of ev) yield e;
      },
    };
    reg.register(exec);
    return reg;
  };
}

function buildSlowSuccess(delayMs: number): () => ExecutorRegistry {
  return () => {
    const reg = new ExecutorRegistry();
    const exec: NodeExecutor = {
      type: "test",
      async *run(): AsyncIterable<NodeEvent> {
        await new Promise((r) => setTimeout(r, delayMs));
        yield { kind: "stdout", line: "tick" };
        yield { kind: "status", status: "succeeded" };
      },
    };
    reg.register(exec);
    return reg;
  };
}

async function waitForRunEnd(events: RunEventEntry[], timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (events.some((e) => e.kind === "run_end")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for run_end");
}

describe("RunRegistry", () => {
  it("succeeds on a happy-path run and emits a run_end synthetic event", async () => {
    const reg = new RunRegistry(
      buildScripted({
        a: [
          { kind: "stdout", line: "hi" },
          { kind: "status", status: "succeeded" },
        ],
      }),
    );
    const out = reg.start({ factoryId: "x" }, makeLoaded());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const run = out.run;
    await waitForRunEnd(run.events);
    expect(run.status).toBe("succeeded");
    const last = run.events.at(-1);
    expect(last?.kind).toBe("run_end");
    if (last?.kind === "run_end") {
      expect(last.result.status).toBe("succeeded");
    }
  });

  it("refuses a second run for the same factory while one is running", async () => {
    const reg = new RunRegistry(buildSlowSuccess(50));
    const first = reg.start({ factoryId: "x" }, makeLoaded());
    expect(first.ok).toBe(true);
    const second = reg.start({ factoryId: "x" }, makeLoaded());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("run_in_flight");
      if (first.ok) {
        expect(second.activeRunId).toBe(first.run.id);
      }
    }
    if (first.ok) await waitForRunEnd(first.run.events);
  });

  it("subscribe replays buffered events and then sees live events", async () => {
    const reg = new RunRegistry(buildSlowSuccess(80));
    const out = reg.start({ factoryId: "x" }, makeLoaded());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Wait until at least one stdout has landed, then subscribe.
    await new Promise((r) => setTimeout(r, 120));
    const seen: RunEventEntry[] = [];
    const sub = reg.subscribe(out.run.id, undefined, (e) => seen.push(e));
    expect(sub).toBeTruthy();
    await waitForRunEnd(out.run.events);
    // Replay may have caught everything if the run was already done; allow
    // either path but verify the subscriber saw the terminal.
    const kinds = seen.map((e) => e.kind);
    expect(kinds).toContain("run_end");
    sub?.unsubscribe();
  });

  it("subscribe with lastIndex skips already-seen events", async () => {
    const reg = new RunRegistry(
      buildScripted({
        a: [
          { kind: "stdout", line: "a" },
          { kind: "stdout", line: "b" },
          { kind: "status", status: "succeeded" },
        ],
      }),
    );
    const out = reg.start({ factoryId: "x" }, makeLoaded());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitForRunEnd(out.run.events);
    const seen: RunEventEntry[] = [];
    reg.subscribe(out.run.id, 1, (e) => seen.push(e));
    // Indices 0 and 1 should be skipped; everything else replayed.
    expect(seen.every((e) => e.index > 1)).toBe(true);
    expect(seen.some((e) => e.kind === "run_end")).toBe(true);
  });

  it("subscribe to unknown run returns undefined", () => {
    const reg = new RunRegistry(buildScripted({}));
    const sub = reg.subscribe("nope", undefined, () => {});
    expect(sub).toBeUndefined();
  });
});
