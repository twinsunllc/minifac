import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * JSON Schema (draft 2020-12) support for `type: value` outputs (ADR 0054).
 *
 * One shared Ajv instance:
 *  - `strictSchema: true` — an unknown keyword (a typo such as `requried`)
 *    is a compile error, so it surfaces as a load error rather than a schema
 *    that silently checks nothing. Ajv's other strict checks
 *    (`strictTypes`, `strictTuples`, `strictRequired`) are off: they refuse
 *    schemas that are valid 2020-12, such as `properties` without
 *    `type: object`.
 *  - `allErrors: true` — every violation is reported, not only the first.
 *  - `validateFormats: false` — `format` is an annotation, as 2020-12's
 *    format-annotation vocabulary defines it; no format plugin is loaded.
 *  - `addUsedSchema: false` — a schema's `$id` is not registered on the
 *    shared instance, so two steps that happen to declare the same `$id`
 *    do not collide.
 */
const ajv = new Ajv2020({
  strictSchema: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allErrors: true,
  validateFormats: false,
  addUsedSchema: false,
});

export interface OutputSchemaViolation {
  /** RFC 6901 JSON pointer into the value (Ajv's `instancePath`): `""` for
   *  the root, which {@link describeViolation} renders as `(root)`. */
  pointer: string;
  /** The violated JSON Schema keyword, e.g. `enum`, `required`, `type`. */
  keyword: string;
  /** Ajv's human-readable message for the violation. */
  message: string;
}

const compiled = new WeakMap<object, ValidateFunction>();
let compiledTrue: ValidateFunction | null = null;
let compiledFalse: ValidateFunction | null = null;

function compile(schema: object | boolean): ValidateFunction {
  if (typeof schema === "boolean") {
    if (schema) {
      compiledTrue ??= ajv.compile(true);
      return compiledTrue;
    }
    compiledFalse ??= ajv.compile(false);
    return compiledFalse;
  }
  const cached = compiled.get(schema);
  if (cached) return cached;
  const fn = ajv.compile(schema);
  compiled.set(schema, fn);
  return fn;
}

/**
 * Check that `schema` is a usable draft 2020-12 JSON Schema. Returns null
 * when it compiles, or the reason it does not.
 */
export function checkOutputSchema(schema: unknown): string | null {
  if (typeof schema !== "boolean" && (schema === null || typeof schema !== "object")) {
    return "a JSON Schema must be an object or a boolean";
  }
  if (Array.isArray(schema)) {
    return "a JSON Schema must be an object or a boolean";
  }
  try {
    compile(schema);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Validate `value` against `schema`. Returns every violation, or an empty
 * array when the value matches. `schema` must already have passed
 * {@link checkOutputSchema} (the loader guarantees this).
 */
export function validateOutputValue(
  schema: object | boolean,
  value: unknown,
): OutputSchemaViolation[] {
  const fn = compile(schema);
  if (fn(value)) return [];
  return (fn.errors ?? []).map((e) => ({
    pointer: e.instancePath,
    keyword: e.keyword,
    message: e.message ?? "",
  }));
}

/** Render a violation the way the node's failure reason does. The root
 *  pointer, `""`, reads as `(root)`. */
export function describeViolation(key: string, v: OutputSchemaViolation): string {
  const at = v.pointer === "" ? "(root)" : v.pointer;
  return `output "${key}" at ${at}: ${v.keyword} (${v.message})`;
}
