import { describe, expect, it } from "vitest";
// The viewer's own browser module, imported as served.
import { edgeStyle, edgeTooltip, routeEdgesOf, valueConditionText } from "./web/edge-style.js";

describe("viewer edgeStyle", () => {
  it("draws on_success with the plain class and arrow", () => {
    expect(edgeStyle("on_success")).toEqual({ cls: "edge-path", marker: "url(#arrow)" });
  });

  it("draws on_failure with its own class and marker", () => {
    expect(edgeStyle("on_failure")).toEqual({
      cls: "edge-path on-failure",
      marker: "url(#arrow-fail)",
    });
  });

  it("draws on_error distinctly from both on_success and on_failure", () => {
    const error = edgeStyle("on_error");
    expect(error).toEqual({ cls: "edge-path on-error", marker: "url(#arrow-error)" });
    for (const other of [edgeStyle("on_success"), edgeStyle("on_failure")]) {
      expect(error.cls).not.toBe(other.cls);
      expect(error.marker).not.toBe(other.marker);
    }
  });

  it("draws a value edge (an object `when`, ADR 0055) distinctly from every literal", () => {
    const value = edgeStyle({ output: "result.decision", equals: "revise" });
    expect(value).toEqual({ cls: "edge-path on-value", marker: "url(#arrow-value)" });
    for (const lit of ["on_success", "on_failure", "on_error"]) {
      expect(value.cls).not.toBe(edgeStyle(lit).cls);
      expect(value.marker).not.toBe(edgeStyle(lit).marker);
    }
  });

  it("labels a value edge with its condition and an outcome edge with nothing", () => {
    expect(valueConditionText({ output: "result.decision", equals: "revise" })).toBe(
      'result.decision = "revise"',
    );
    expect(valueConditionText({ output: "result.decision", in: ["a", "b"] })).toBe(
      'result.decision in ["a","b"]',
    );
    expect(valueConditionText("on_success")).toBeNull();
    expect(valueConditionText(undefined)).toBeNull();
  });

  it("draws a route (ADR 0055) distinctly from every literal and from a value edge", () => {
    const route = edgeStyle("route");
    expect(route).toEqual({ cls: "edge-path on-route", marker: "url(#arrow-route)" });
    for (const other of [
      edgeStyle("on_success"),
      edgeStyle("on_failure"),
      edgeStyle("on_error"),
      edgeStyle({ output: "next", equals: "a" }),
    ]) {
      expect(route.cls).not.toBe(other.cls);
      expect(route.marker).not.toBe(other.marker);
    }
  });

  it("derives route edges from nodes' routes, bare ids and object entries alike", () => {
    expect(
      routeEdgesOf({
        implement: {},
        evaluate: { routes: ["implement", { to: "checks_gate", max_traversals: 2 }] },
      }),
    ).toEqual([
      { from: "evaluate", to: "implement", when: "route" },
      { from: "evaluate", to: "checks_gate", when: "route" },
    ]);
    expect(routeEdgesOf({ a: {} })).toEqual([]);
  });

  it("labels a route with the node that chooses it", () => {
    expect(edgeTooltip({ from: "evaluate", when: "route" })).toBe("route (chosen by evaluate)");
    expect(edgeTooltip({ from: "evaluate", when: { output: "r", equals: 1 } })).toBe("r = 1");
    expect(edgeTooltip({ from: "evaluate", when: "on_success" })).toBeNull();
  });
});
