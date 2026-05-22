import { describe, expect, it } from "vitest";
import { NodeSchema, OutputDefSchema, OutputsMapSchema } from "./schema.js";

describe("OutputsMapSchema — node `outputs:` block", () => {
  it("accepts a node `outputs:` map with multiple keys", () => {
    const out = OutputsMapSchema.parse({
      findings: { type: "value", required: true },
      report: { type: "file", filename: "report.md" },
    });
    expect(out.findings?.type).toBe("value");
    expect(out.report?.type).toBe("file");
  });

  it("accepts an empty outputs map", () => {
    expect(OutputsMapSchema.parse({})).toEqual({});
  });

  it("rejects an output key starting with a digit", () => {
    expect(() => OutputsMapSchema.parse({ "123findings": { type: "value" } })).toThrowError(
      /123findings/,
    );
  });

  it("rejects an output key containing a hyphen", () => {
    expect(() => OutputsMapSchema.parse({ "findings-1": { type: "value" } })).toThrowError(
      /findings-1/,
    );
  });
});

describe("OutputDefSchema — discriminated types", () => {
  it("accepts type: value with all optional fields", () => {
    const out = OutputDefSchema.parse({
      type: "value",
      required: true,
      description: "code review findings",
    });
    expect(out).toMatchObject({ type: "value", required: true });
  });

  it("accepts type: value with reserved shape field (passes through)", () => {
    const out = OutputDefSchema.parse({
      type: "value",
      shape: { items: "array" },
    });
    expect((out as { shape?: unknown }).shape).toEqual({ items: "array" });
  });

  it("defaults `required` to false on value outputs", () => {
    const out = OutputDefSchema.parse({ type: "value" });
    expect((out as { required: boolean }).required).toBe(false);
  });

  it("accepts type: file with explicit filename", () => {
    const out = OutputDefSchema.parse({
      type: "file",
      filename: "patch.diff",
      required: true,
    });
    expect(out).toMatchObject({ type: "file", filename: "patch.diff" });
  });

  it("rejects type: file with filename containing a slash", () => {
    expect(() =>
      OutputDefSchema.parse({ type: "file", filename: "sub/patch.diff" }),
    ).toThrowError(/path separators/);
  });

  it("rejects type: file with empty filename", () => {
    expect(() => OutputDefSchema.parse({ type: "file", filename: "" })).toThrowError(/filename/);
  });

  it("accepts type: directory with description", () => {
    const out = OutputDefSchema.parse({
      type: "directory",
      required: false,
      description: "test output logs",
    });
    expect(out.type).toBe("directory");
  });

  it("rejects unknown type", () => {
    expect(() => OutputDefSchema.parse({ type: "blob" })).toThrowError();
  });

  it("rejects unknown sibling field within value branch", () => {
    expect(() => OutputDefSchema.parse({ type: "value", maxBytes: 1024 })).toThrowError();
  });
});

describe("NodeSchema with outputs", () => {
  it("accepts a node declaring outputs alongside executor + with", () => {
    const node = NodeSchema.parse({
      executor: "claude",
      with: { prompt: "..." },
      outputs: { findings: { type: "value", required: true } },
    });
    expect(node.outputs?.findings).toMatchObject({ type: "value", required: true });
  });

  it("accepts a node with no outputs", () => {
    const node = NodeSchema.parse({ executor: "claude" });
    expect(node.outputs).toBeUndefined();
  });

  it("rejects unknown node-level keys (strict-on-extras preserved)", () => {
    expect(() =>
      NodeSchema.parse({ executor: "claude", retry: 3 }),
    ).toThrowError(/retry/);
  });
});
