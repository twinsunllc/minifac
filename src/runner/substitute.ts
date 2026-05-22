import type { Brief } from "../brief/loader.js";

const TOKEN_REGEX = /\{\{\s*(brief|run|inputs)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export interface Substitutions {
  brief?: Brief;
  /** Run-scope token namespace. Fields are individually optional — set the
   * ones the caller actually has in scope. Tokens whose corresponding
   * field is absent pass through verbatim (matching the `brief.*`
   * convention). */
  run?: { cwd?: string; base_branch?: string };
  /** Per-node inputs map produced at step inlining time. Absent on inline
   * nodes (never inlined from a step). When absent, `{{ inputs.* }}`
   * tokens pass through verbatim. */
  inputs?: Record<string, unknown>;
}

/**
 * Substitute `{{ <ns>.<field> }}` tokens (ns ∈ {brief, run, inputs}) in
 * `input` using values from `subs`. Unknown ns or unknown fields under
 * a known ns pass through verbatim.
 *
 * `inputs` stringification rules:
 *  - string → verbatim
 *  - number/boolean → `String(value)`
 *  - array/object → `JSON.stringify(value)`
 *  - null/undefined → empty string
 *  - absent (when the field isn't in the inputs map at all) → empty string
 *    if `subs.inputs` is in scope; verbatim if no inputs map is in scope
 *    (inline node).
 */
export function substitute(input: string, subs: Substitutions): string {
  // Two passes so a templated input value (e.g. `inputs.change ===
  // "{{ brief.change }}"`) gets resolved end-to-end: first pass swaps
  // `{{ inputs.change }}` for the brief token, second pass resolves the
  // brief token to its value. The second pass is a no-op when the first
  // pass introduced no new tokens.
  const first = substituteOnce(input, subs);
  if (first === input) return first;
  return substituteOnce(first, subs);
}

function substituteOnce(input: string, subs: Substitutions): string {
  return input.replace(TOKEN_REGEX, (match, ns: string, field: string) => {
    if (ns === "brief") {
      const brief = subs.brief;
      if (!brief) return match;
      switch (field) {
        case "change":
          return brief.frontmatter.change;
        case "factory":
          return brief.frontmatter.factory;
        case "body":
          return brief.body;
        case "base_branch":
          return brief.frontmatter.base_branch ?? "";
        case "model":
          return brief.frontmatter.model ?? "";
        default:
          return match;
      }
    }
    if (ns === "run") {
      const run = subs.run;
      if (!run) return match;
      if (field === "cwd") {
        return run.cwd ?? match;
      }
      if (field === "base_branch") {
        return run.base_branch ?? match;
      }
      return match;
    }
    if (ns === "inputs") {
      if (subs.inputs === undefined) return match;
      if (!Object.hasOwn(subs.inputs, field)) return "";
      return stringifyInputValue(subs.inputs[field]);
    }
    return match;
  });
}

function stringifyInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // array or object — deterministic JSON
  return JSON.stringify(value);
}

/**
 * Back-compat shim for callers that still substitute only brief tokens.
 * New callers should use `substitute` directly with a `Substitutions` record.
 */
export function substituteBriefTokens(prompt: string, brief: Brief): string {
  return substitute(prompt, { brief });
}
