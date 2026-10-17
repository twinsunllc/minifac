import { describe, expect, it } from "vitest";
import { checkOutputSchema, describeViolation, validateOutputValue } from "./output-schema.js";

const verdictSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { enum: ["pass", "fail"] } },
};

describe("checkOutputSchema", () => {
  it("accepts a valid draft 2020-12 schema, and the boolean schemas", () => {
    expect(checkOutputSchema(verdictSchema)).toBeNull();
    expect(
      checkOutputSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "array",
        prefixItems: [{ type: "string" }],
      }),
    ).toBeNull();
    // Valid 2020-12 that Ajv's strictTypes would refuse: no `type: object`.
    expect(checkOutputSchema({ required: ["verdict"], properties: { verdict: {} } })).toBeNull();
    expect(checkOutputSchema(true)).toBeNull();
    expect(checkOutputSchema(false)).toBeNull();
  });

  it("refuses a schema that fails meta-validation", () => {
    expect(checkOutputSchema({ type: "strng" })).toMatch(/schema is invalid/);
    expect(checkOutputSchema({ required: "x" })).toMatch(/schema is invalid/);
  });

  it("refuses an unknown keyword (strictSchema), so a typo is not silently ignored", () => {
    expect(checkOutputSchema({ type: "object", requried: ["verdict"] })).toMatch(
      /unknown keyword: "requried"/,
    );
  });

  it("refuses a non-object, non-boolean schema", () => {
    expect(checkOutputSchema("object")).toMatch(/object or a boolean/);
    expect(checkOutputSchema(null)).toMatch(/object or a boolean/);
    expect(checkOutputSchema([])).toMatch(/object or a boolean/);
  });

  it("does not register `$id`, so two schemas sharing one do not collide", () => {
    expect(
      checkOutputSchema({ $id: "https://example.test/result.json", type: "object" }),
    ).toBeNull();
    expect(
      checkOutputSchema({ $id: "https://example.test/result.json", type: "string" }),
    ).toBeNull();
  });
});

describe("validateOutputValue", () => {
  it("returns no violations for a matching value", () => {
    expect(validateOutputValue(verdictSchema, { verdict: "pass" })).toEqual([]);
  });

  it("names the pointer and keyword of an enum violation", () => {
    expect(validateOutputValue(verdictSchema, { verdict: "maybe" })).toEqual([
      expect.objectContaining({ pointer: "/verdict", keyword: "enum" }),
    ]);
  });

  it("reports a missing required property at the parent object's pointer", () => {
    const nested = { type: "object", properties: { head_sha: verdictSchema } };
    expect(validateOutputValue(nested, { head_sha: {} })).toEqual([
      expect.objectContaining({ pointer: "/head_sha", keyword: "required" }),
    ]);
  });

  it("renders the root pointer as `/`", () => {
    expect(validateOutputValue(verdictSchema, "pass")).toEqual([
      expect.objectContaining({ pointer: "/", keyword: "type" }),
    ]);
  });

  it("reports every violation (allErrors)", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
    };
    expect(validateOutputValue(schema, { a: 1, b: "x" }).map((v) => v.pointer)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("treats `format` as an annotation", () => {
    expect(validateOutputValue({ type: "string", format: "email" }, "not-an-email")).toEqual([]);
  });

  it("describeViolation renders key, pointer, keyword and message", () => {
    const [v] = validateOutputValue(verdictSchema, { verdict: "maybe" });
    expect(describeViolation("result", v as never)).toBe(
      'output "result" at /verdict: enum (must be equal to one of the allowed values)',
    );
  });
});
