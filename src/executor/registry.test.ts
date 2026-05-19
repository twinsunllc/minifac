import { describe, expect, it } from "vitest";
import { ExecutorRegistry } from "./registry.js";
import type { NodeEvent, NodeExecutor } from "./types.js";

function makeExecutor(type: string): NodeExecutor {
  return {
    type,
    async *run(): AsyncIterable<NodeEvent> {
      yield { kind: "status", status: "succeeded" };
    },
  };
}

describe("ExecutorRegistry", () => {
  it("registers and retrieves an executor by type", () => {
    const reg = new ExecutorRegistry();
    reg.register(makeExecutor("claude"));
    expect(reg.has("claude")).toBe(true);
    expect(reg.get("claude")?.type).toBe("claude");
  });

  it("returns undefined for unknown types", () => {
    const reg = new ExecutorRegistry();
    expect(reg.get("codex")).toBeUndefined();
    expect(reg.has("codex")).toBe(false);
  });

  it("rejects duplicate registration of the same type", () => {
    const reg = new ExecutorRegistry();
    reg.register(makeExecutor("claude"));
    expect(() => reg.register(makeExecutor("claude"))).toThrowError(/already registered/);
  });
});
