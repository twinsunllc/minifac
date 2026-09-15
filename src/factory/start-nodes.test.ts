import { describe, expect, it } from "vitest";
import type { Factory } from "./schema.js";
import { startNodeIds } from "./start-nodes.js";

const node = (extra: Partial<Factory["nodes"][string]> = {}) => ({
  executor: "claude",
  terminal: false,
  ...extra,
});

describe("startNodeIds", () => {
  it("returns every node when there are no edges", () => {
    const f: Factory = { name: "f", nodes: { a: node(), b: node() }, edges: [] };
    expect(startNodeIds(f)).toEqual(["a", "b"]);
  });

  it("excludes on_success targets", () => {
    const f: Factory = {
      name: "f",
      nodes: { a: node(), b: node() },
      edges: [{ from: "a", to: "b", when: "on_success" }],
    };
    expect(startNodeIds(f)).toEqual(["a"]);
  });

  it("excludes on_failure-only targets (F6: escalation / wait / re-poll nodes)", () => {
    const f: Factory = {
      name: "f",
      nodes: { a: node(), b: node(), ask: node(), z: node() },
      edges: [
        { from: "a", to: "b", when: "on_success" },
        { from: "b", to: "ask", when: "on_failure" },
        { from: "b", to: "z", when: "on_success" },
      ],
    };
    expect(startNodeIds(f)).toEqual(["a"]);
  });

  it("ignores self-loops: a node whose only inbound edge is its own still starts", () => {
    const f: Factory = {
      name: "f",
      nodes: { a: node(), t: node() },
      edges: [
        { from: "a", to: "a", when: "on_failure" },
        { from: "a", to: "t", when: "on_success" },
      ],
    };
    expect(startNodeIds(f)).toEqual(["a"]);
  });

  it("a closed cycle has no start node without a declaration", () => {
    const f: Factory = {
      name: "f",
      nodes: { p: node(), v: node() },
      edges: [
        { from: "p", to: "v", when: "on_success" },
        { from: "v", to: "p", when: "on_failure" },
      ],
    };
    expect(startNodeIds(f)).toEqual([]);
  });

  it("`start: true` opts a node with inbound edges in", () => {
    const f: Factory = {
      name: "f",
      nodes: { p: node({ start: true }), v: node() },
      edges: [
        { from: "p", to: "v", when: "on_success" },
        { from: "v", to: "p", when: "on_failure" },
      ],
    };
    expect(startNodeIds(f)).toEqual(["p"]);
  });

  it("`start: false` is the same as omitted", () => {
    const f: Factory = {
      name: "f",
      nodes: { a: node({ start: false }), b: node({ start: false }) },
      edges: [{ from: "a", to: "b", when: "on_success" }],
    };
    expect(startNodeIds(f)).toEqual(["a"]);
  });

  it("preserves declaration order, mixing declared and inferred starts", () => {
    const f: Factory = {
      name: "f",
      nodes: { x: node(), s: node({ start: true }), y: node() },
      edges: [
        { from: "x", to: "s", when: "on_success" },
        { from: "s", to: "y", when: "on_success" },
      ],
    };
    expect(startNodeIds(f)).toEqual(["x", "s"]);
  });
});
