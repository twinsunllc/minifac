import { describe, expect, it } from "vitest";
import { renderNodeEvent, renderStreamJsonLine, shortenOneLine } from "./event-rendering.js";

describe("shortenOneLine", () => {
  it("collapses whitespace runs into single spaces", () => {
    expect(shortenOneLine("a   b\tc\n  d")).toBe("a b c d");
  });
  it("trims leading/trailing whitespace", () => {
    expect(shortenOneLine("  hello  ")).toBe("hello");
  });
  it("truncates with ellipsis at limit", () => {
    const long = "x".repeat(120);
    const out = shortenOneLine(long);
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
  it("respects custom limit", () => {
    expect(shortenOneLine("xxxxx", 4)).toBe("xxx…");
  });
});

describe("renderStreamJsonLine", () => {
  it("suppresses system/init events", () => {
    const r = renderStreamJsonLine('{"type":"system","subtype":"init"}');
    expect(r.kind).toBe("system_init");
    expect(r.suppressed).toBe(true);
    expect(r.fullJson).toContain('"type": "system"');
  });

  it("suppresses non-rejected rate_limit_event events", () => {
    const r = renderStreamJsonLine('{"type":"rate_limit_event","status":"allowed"}');
    expect(r.kind).toBe("rate_limit");
    expect(r.suppressed).toBe(true);
  });

  it("highlights rejected rate_limit_event events", () => {
    const r = renderStreamJsonLine(
      '{"type":"rate_limit_event","status":"rejected","reason":"quota"}',
    );
    expect(r.kind).toBe("rate_limit");
    expect(r.suppressed).toBeFalsy();
    expect(r.highlight).toBe("rejected");
    expect(r.summary).toContain("quota");
  });

  it("renders assistant text as prose", () => {
    const r = renderStreamJsonLine(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}',
    );
    expect(r.kind).toBe("text");
    expect(r.summary).toBe("hello world");
  });

  it("renders tool_use as → Tool(short args)", () => {
    const r = renderStreamJsonLine(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}',
    );
    expect(r.kind).toBe("tool_use");
    expect(r.summary).toBe('→ Bash({"command":"npm test"})');
  });

  it("renders tool_result with ✓ when success", () => {
    const r = renderStreamJsonLine(
      '{"type":"user","message":{"content":[{"type":"tool_result","is_error":false,"content":"all good"}]}}',
    );
    expect(r.kind).toBe("tool_result");
    expect(r.summary.startsWith("✓ ")).toBe(true);
    expect(r.summary).toContain("all good");
  });

  it("renders tool_result with ✗ when error", () => {
    const r = renderStreamJsonLine(
      '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"oh no"}]}}',
    );
    expect(r.kind).toBe("tool_result");
    expect(r.summary.startsWith("✗ ")).toBe(true);
  });

  it("renders result as terminal status line", () => {
    const r = renderStreamJsonLine('{"type":"result","subtype":"success","result":"done"}');
    expect(r.kind).toBe("result");
    expect(r.summary).toContain("result:");
    expect(r.highlight).toBe("result-succeeded");
  });

  it("renders unparseable lines as raw kind", () => {
    const r = renderStreamJsonLine("not json here {");
    expect(r.kind).toBe("raw");
    expect(r.summary).toContain("not json here");
  });

  it("includes fullJson for parsed events", () => {
    const r = renderStreamJsonLine('{"type":"system","subtype":"init"}');
    expect(typeof r.fullJson).toBe("string");
    expect(r.fullJson).toContain("\n");
  });

  it("truncates long tool input to ~80 chars with ellipsis", () => {
    const longCmd = "x".repeat(200);
    const r = renderStreamJsonLine(
      `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"${longCmd}"}}]}}`,
    );
    expect(r.kind).toBe("tool_use");
    expect(r.summary.endsWith("…")).toBe(true);
    expect(r.summary.length).toBeLessThanOrEqual(80);
  });
});

describe("renderNodeEvent", () => {
  it("renders stderr as raw with summary", () => {
    const r = renderNodeEvent({
      nodeId: "x",
      iteration: 1,
      emittedAt: 0,
      event: { kind: "stderr", line: "warn: thing" },
    });
    expect(r.kind).toBe("raw");
    expect(r.summary).toContain("warn: thing");
  });

  it("renders synthetic status events with highlight=status", () => {
    const r = renderNodeEvent({
      nodeId: "propose",
      iteration: 2,
      emittedAt: 0,
      event: { kind: "status", status: "succeeded" },
    });
    expect(r.kind).toBe("status");
    expect(r.highlight).toBe("status");
    expect(r.summary).toContain("propose iter=2: succeeded");
  });

  it("renders stdout via stream-json parsing", () => {
    const r = renderNodeEvent({
      nodeId: "propose",
      iteration: 1,
      emittedAt: 0,
      event: { kind: "stdout", line: '{"type":"system","subtype":"init"}' },
    });
    expect(r.kind).toBe("system_init");
    expect(r.suppressed).toBe(true);
  });
});
