import { describe, expect, it } from "vitest";
// The viewer's own browser module, imported as served.
import { edgeStyle } from "./web/edge-style.js";

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
});
