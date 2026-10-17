import { z } from "zod";
import { FactoryLoadError } from "./loader-error.js";
import type { GraphEdge } from "./routes.js";
import type { Factory, FactoryEdge } from "./schema.js";

/**
 * Value-conditioned edges (ADR 0055). An edge's `when` may be an outcome
 * literal or a condition on one of the `from` node's `type: value` outputs:
 *
 *   when: { output: result.decision, equals: revise }
 *   when: { output: result.decision, in: [revise, rework] }
 *
 * `output` is a declared output key followed by zero or more dotted property
 * names. Arrays are not indexed.
 */

/** An output key (as `OUTPUT_KEY_REGEX` in schema.ts), then `.<property>` segments. */
const OUTPUT_PATH_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_-]+)*$/;

const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()], {
  errorMap: () => ({ message: "must be a JSON scalar (string, number, boolean or null)" }),
});

export const ValueConditionSchema = z
  .object({
    output: z
      .string()
      .regex(
        OUTPUT_PATH_REGEX,
        "output must be an output key followed by dotted property names, e.g. result.decision",
      ),
    equals: ScalarSchema.optional(),
    in: z.array(ScalarSchema).min(1, "`in` must list at least one value").optional(),
  })
  .strict()
  .superRefine((cond, ctx) => {
    if ((cond.equals !== undefined) === (cond.in !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a value condition takes exactly one of `equals` and `in`",
      });
    }
  });

export type ValueCondition = z.infer<typeof ValueConditionSchema>;
type Scalar = string | number | boolean | null;

export function isValueCondition(when: GraphEdge["when"]): when is ValueCondition {
  return typeof when === "object" && when !== null;
}

/** The values a condition matches: `[equals]` or the `in` list. */
function conditionValues(cond: ValueCondition): Scalar[] {
  return cond.in ?? [cond.equals as Scalar];
}

/**
 * The `when` part of an edge's traversal key: the literal for an outcome
 * edge, `route` for a route, `output:<path>=<JSON>` or
 * `output:<path> in <JSON array>` for a value edge. The runner keys
 * `max_traversals` counts, park/resume `edgeTraversals` and `via` as
 * `<from>-><to>:<edgeWhenKey>`.
 */
export function edgeWhenKey(edge: Pick<GraphEdge, "when">): string {
  const when = edge.when;
  if (!isValueCondition(when)) return when;
  return when.in !== undefined
    ? `output:${when.output} in ${JSON.stringify(when.in)}`
    : `output:${when.output}=${JSON.stringify(when.equals)}`;
}

/** Split `result.decision` into the output key and the property path. */
export function splitOutputPath(output: string): { key: string; props: string[] } {
  const [key = "", ...props] = output.split(".");
  return { key, props };
}

/**
 * Walk `props` through plain objects. Returns `{ found: false }` when a
 * segment is missing or a step meets a non-object (arrays included).
 */
export function resolveOutputPath(
  value: unknown,
  props: string[],
): { found: true; value: unknown } | { found: false } {
  let cur = value;
  for (const prop of props) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return { found: false };
    if (!Object.hasOwn(cur, prop)) return { found: false };
    cur = (cur as Record<string, unknown>)[prop];
  }
  return { found: true, value: cur };
}

/** Whether `value` (the whole output) satisfies `cond`, by strict equality. */
export function conditionMatches(cond: ValueCondition, value: unknown): boolean {
  const resolved = resolveOutputPath(value, splitOutputPath(cond.output).props);
  if (!resolved.found) return false;
  return conditionValues(cond).some((v) => v === resolved.value);
}

type PathCheck = { possible: false; reason: string } | { possible: true; leaf?: unknown };

/**
 * Whether `props` can exist in a value valid under `schema`. Only direct
 * keywords are read: a `false` schema, a `type` that excludes `object`, and
 * `additionalProperties: false` with no matching `properties` or
 * `patternProperties` entry rule a path out. JSON Schema keywords are
 * conjunctive, so these hold whatever `$ref`/`allOf`/`anyOf` add; a path
 * those would decide is accepted (`leaf` undefined).
 */
function checkSchemaPath(schema: unknown, props: string[]): PathCheck {
  let cur: unknown = schema;
  for (const [i, prop] of props.entries()) {
    const at = i === 0 ? "the output" : `"${props.slice(0, i).join(".")}"`;
    if (cur === false) return { possible: false, reason: `the schema at ${at} is \`false\`` };
    if (cur === null || typeof cur !== "object") return { possible: true };
    const s = cur as Record<string, unknown>;
    const types = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? s.type : null;
    if (types !== null && !types.includes("object")) {
      return {
        possible: false,
        reason: `the schema at ${at} has type ${JSON.stringify(s.type)}, so it has no property "${prop}"`,
      };
    }
    const properties = s.properties as Record<string, unknown> | undefined;
    if (properties !== undefined && Object.hasOwn(properties, prop)) {
      cur = properties[prop];
      continue;
    }
    const patterns = (s.patternProperties ?? {}) as Record<string, unknown>;
    const pattern = Object.keys(patterns).find((p) => new RegExp(p, "u").test(prop));
    if (pattern !== undefined) {
      cur = patterns[pattern];
      continue;
    }
    if (s.additionalProperties === false) {
      return {
        possible: false,
        reason: `the schema at ${at} sets \`additionalProperties: false\` and declares no property "${prop}"`,
      };
    }
    if (s.additionalProperties !== undefined) {
      cur = s.additionalProperties;
      continue;
    }
    return { possible: true };
  }
  if (cur === false) return { possible: false, reason: "the schema at the path is `false`" };
  return { possible: true, leaf: cur };
}

/** Values of `cond` a leaf `const`/`enum` rules out. */
function valuesOutsideLeaf(cond: ValueCondition, leaf: unknown): Scalar[] {
  if (leaf === null || typeof leaf !== "object") return [];
  const s = leaf as Record<string, unknown>;
  const values = conditionValues(cond);
  if (Object.hasOwn(s, "const")) return values.filter((v) => v !== s.const);
  if (Array.isArray(s.enum)) {
    const allowed = s.enum;
    return values.filter((v) => !allowed.includes(v));
  }
  return [];
}

function describeEdge(edge: FactoryEdge): string {
  return `${edge.from} → ${edge.to} (when ${edgeWhenKey(edge)})`;
}

/**
 * Load-time checks on every value edge (ADR 0055). Runs after step inlining,
 * so a `uses:` node's step-declared outputs count. Throws on the first:
 *
 *   1. `output`'s key is not a declared `type: value` output of `from`;
 *   2. the path cannot exist under that output's `schema:`;
 *   3. an `equals`/`in` value lies outside the leaf `enum`/`const`;
 *   4. two value edges from one node test the same path with a value in
 *      common (the error names both).
 */
export function validateValueEdges(factory: Factory, sourcePath: string): void {
  const byPath = new Map<string, FactoryEdge[]>();
  for (const edge of factory.edges) {
    const when = edge.when;
    if (!isValueCondition(when)) continue;
    const { key, props } = splitOutputPath(when.output);
    const def = factory.nodes[edge.from]?.outputs?.[key];
    if (def === undefined || def.type !== "value") {
      const declared =
        def === undefined ? "does not declare it" : `declares it as type ${def.type}`;
      throw new FactoryLoadError(
        `Edge ${describeEdge(edge)} tests output "${key}", which must be a \`type: value\` output of node "${edge.from}"; the node ${declared}`,
        sourcePath,
      );
    }
    if (def.schema !== undefined) {
      const check = checkSchemaPath(def.schema, props);
      if (!check.possible) {
        throw new FactoryLoadError(
          `Edge ${describeEdge(edge)} tests path "${when.output}", which cannot exist: ${check.reason}`,
          sourcePath,
        );
      }
      const outside = valuesOutsideLeaf(when, check.leaf);
      if (outside.length > 0) {
        throw new FactoryLoadError(
          `Edge ${describeEdge(edge)} tests path "${when.output}" for ${outside.map((v) => JSON.stringify(v)).join(", ")}, which its schema's enum/const never allows`,
          sourcePath,
        );
      }
    }
    const groupKey = `${edge.from}\u0000${when.output}`;
    const group = byPath.get(groupKey) ?? [];
    for (const other of group) {
      const otherValues = conditionValues(other.when as ValueCondition);
      const shared = conditionValues(when).find((v) => otherValues.includes(v));
      if (shared !== undefined) {
        throw new FactoryLoadError(
          `Edges ${describeEdge(other)} and ${describeEdge(edge)} both match "${when.output}" = ${JSON.stringify(shared)}; value edges from one node on the same path must not overlap`,
          sourcePath,
        );
      }
    }
    group.push(edge);
    byPath.set(groupKey, group);
  }
}
