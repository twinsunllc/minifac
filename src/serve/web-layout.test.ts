import { describe, expect, it } from "vitest";
// The viewer's own browser module, imported as served.
import { edgeLanes, edgePath, layered } from "./web/layout.js";

const revise = { output: "result.decision", equals: "revise" };

describe("viewer layered", () => {
  it("lays out a cycle closed only by routes with one back-edge", () => {
    const { pos } = layered(
      ["a", "b"],
      [
        { from: "a", to: "b", when: "route" },
        { from: "b", to: "a", when: "route" },
      ],
    );
    expect(pos.a).toBeDefined();
    expect(pos.b).toBeDefined();
    expect(pos.b?.x).toBeGreaterThan(pos.a?.x ?? Number.POSITIVE_INFINITY);
  });

  it("lays out a value-edge cycle in strictly increasing columns along its forward edges", () => {
    const { pos } = layered(
      ["s", "a", "b", "c"],
      [
        { from: "s", to: "a", when: "on_success" },
        { from: "a", to: "b", when: revise },
        { from: "b", to: "c", when: revise },
        { from: "c", to: "a", when: revise },
      ],
    );
    const x = (id: string): number => pos[id]?.x ?? Number.NaN;
    expect(x("s")).toBeLessThan(x("a"));
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
  });

  it("still skips a value edge that closes an on_success loop", () => {
    const { pos } = layered(
      ["plan", "implement", "evaluate"],
      [
        { from: "plan", to: "implement", when: "on_success" },
        { from: "implement", to: "evaluate", when: "on_success" },
        { from: "evaluate", to: "implement", when: revise },
      ],
    );
    expect(pos.plan?.x).toBeLessThan(pos.implement?.x ?? Number.NaN);
    expect(pos.implement?.x).toBeLessThan(pos.evaluate?.x ?? Number.NaN);
  });

  it("lays out a plain on_success chain one column per node", () => {
    const { pos, width } = layered(
      ["a", "b", "c"],
      [
        { from: "a", to: "b", when: "on_success" },
        { from: "b", to: "c", when: "on_success" },
      ],
    );
    expect([pos.a?.x, pos.b?.x, pos.c?.x]).toEqual([70, 210, 350]);
    expect(width).toBe(3 * 140 + 40);
  });
});

describe("viewer edgeLanes and edgePath", () => {
  it("gives a route and an outcome edge between one pair different lanes and curves", () => {
    const edges = [
      { from: "e", to: "i", when: "on_failure" },
      { from: "e", to: "i", when: "route" },
    ];
    expect(edgeLanes(edges)).toEqual([0, 1]);
    const a = { x: 70, y: 55 };
    const b = { x: 210, y: 55 };
    const lane0 = edgePath(a, b, 0);
    const lane1 = edgePath(a, b, 1);
    expect(lane0).not.toBe("");
    expect(lane1).not.toBe("");
    expect(lane1).not.toBe(lane0);
  });

  it("gives lane 0 to an edge with no parallel, and keeps the lane-0 curve as it was", () => {
    expect(
      edgeLanes([
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "a", to: "c" },
      ]),
    ).toEqual([0, 0, 0]);
    expect(edgePath({ x: 70, y: 55 }, { x: 210, y: 55 })).toBe("M70,55 Q140,55 210,55");
    expect(edgePath({ x: 70, y: 55 }, { x: 70, y: 55 }, 1)).toBe("");
  });
});
