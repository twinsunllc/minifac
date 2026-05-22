// Schema derivation helpers for the MCP outputs bridge.
//
// The runner exposes one MCP tool per declared `type: "value"` output. The
// tool's input schema is derived from the declared output's optional `shape:`
// hint per the rules in `openspec/specs/graph-runner/spec.md` ("Per-node MCP
// tool registration for `value` outputs"). The mapping is intentionally
// loose in v1 — `shape:` is a forward-compatible slot reserved by
// `node-outputs`; structural typing arrives in a later change.
//
// We expose the derived schema both as a Zod schema (for the SDK's
// `registerTool` input-schema enforcement) and as a small descriptor the
// bridge uses for its defensive double-check.

import { z } from "zod";

export type DerivedShapeKind = "array" | "object" | "string" | "number" | "boolean" | "unknown";

export interface DerivedSchema {
  kind: DerivedShapeKind;
  zod: z.ZodTypeAny;
}

/**
 * Inspect a declared output's `shape:` value and pick the kind of input
 * schema the MCP tool will enforce. Returns `"unknown"` when the shape is
 * absent or doesn't match any of the recognized v1 forms.
 *
 * Recognized v1 forms (per the spec):
 *  - `"array"` (literal string) → array
 *  - `{ items: ... }` → array
 *  - `"object"` (literal string) → object
 *  - `{ fields: ... }` → object
 *  - `"string" | "number" | "boolean"` → corresponding primitive
 *  - anything else (including `undefined`) → `"unknown"`
 */
export function deriveShapeKind(shape: unknown): DerivedShapeKind {
  if (typeof shape === "string") {
    if (shape === "array") return "array";
    if (shape === "object") return "object";
    if (shape === "string") return "string";
    if (shape === "number") return "number";
    if (shape === "boolean") return "boolean";
    return "unknown";
  }
  if (shape && typeof shape === "object" && !Array.isArray(shape)) {
    const s = shape as Record<string, unknown>;
    if ("items" in s) return "array";
    if ("fields" in s) return "object";
  }
  return "unknown";
}

/**
 * Build the derived input schema for a `value` output's MCP tool. The tool
 * input is always an object of the form `{ value: <derived> }`.
 */
export function deriveValueSchema(shape: unknown): DerivedSchema {
  const kind = deriveShapeKind(shape);
  switch (kind) {
    case "array":
      return { kind, zod: z.array(z.unknown()) };
    case "object":
      return { kind, zod: z.object({}).passthrough() };
    case "string":
      return { kind, zod: z.string() };
    case "number":
      return { kind, zod: z.number() };
    case "boolean":
      return { kind, zod: z.boolean() };
    default:
      return { kind: "unknown", zod: z.unknown() };
  }
}

/**
 * Validate a raw payload against the derived schema. Returns the parsed
 * value on success or a one-line error string on mismatch.
 */
export function validateValuePayload(
  shape: unknown,
  payload: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const { zod } = deriveValueSchema(shape);
  const parsed = zod.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return { ok: false, error: `${path}${issue?.message ?? "schema mismatch"}` };
}
