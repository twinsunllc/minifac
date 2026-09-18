import { readFileSync, statSync } from "node:fs";
import type { Brief } from "../brief/loader.js";
import type { NodeResult } from "../executor/types.js";
import type { NodeOutputIndex } from "../factory/schema.js";

const TOKEN_REGEX = /\{\{\s*(brief|run|inputs)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

const PRIOR_RESULTS_TOKEN_REGEX =
  /\{\{\s*priorResults\.([a-zA-Z_][a-zA-Z0-9_-]*)\.outputs\.([a-zA-Z_][a-zA-Z0-9_]*)(:read)?\s*\}\}/g;

/** `{{ priorResults.<id>.status }}` / `{{ priorResults.<id>.reason }}` —
 * the latest-iteration terminal status and sentinel REASON of a node, so a
 * downstream prompt can branch on how its source ended (ADR 0041). */
const PRIOR_RESULTS_FIELD_TOKEN_REGEX =
  /\{\{\s*priorResults\.([a-zA-Z_][a-zA-Z0-9_-]*)\.(status|reason)\s*\}\}/g;

export const PRIOR_RESULTS_READ_CAP = 64 * 1024;

export interface Substitutions {
  brief?: Brief;
  /** Run-scope token namespace. Fields are individually optional — set the
   * ones the caller actually has in scope. Tokens whose corresponding
   * field is absent pass through verbatim (matching the `brief.*`
   * convention). */
  run?: { cwd?: string; outputsDir?: string; base_branch?: string; feedback?: string };
  /** Per-node inputs map produced at step inlining time. Absent on inline
   * nodes (never inlined from a step). When absent, `{{ inputs.* }}`
   * tokens pass through verbatim. */
  inputs?: Record<string, unknown>;
  /** Latest-iteration NodeResult per node id, used to resolve
   * `{{ priorResults.<id>.outputs.<key>[:read] }}` and
   * `{{ priorResults.<id>.status|reason }}` tokens. */
  priorResults?: ReadonlyMap<string, NodeResult>;
}

/**
 * Substitute `{{ <ns>.<field> }}` tokens (ns ∈ {brief, run, inputs}),
 * `{{ priorResults.<id>.outputs.<key>[:read] }}` tokens and
 * `{{ priorResults.<id>.status|reason }}` tokens in `input` using values
 * from `subs`. Unknown ns or unknown fields under a known ns pass through
 * verbatim.
 */
export function substitute(input: string, subs: Substitutions): string {
  const first = substituteOnce(input, subs);
  if (first === input) return first;
  return substituteOnce(first, subs);
}

function substituteOnce(input: string, subs: Substitutions): string {
  let out = substitutePriorResults(input, subs);
  out = substitutePriorResultFields(out, subs);
  out = out.replace(TOKEN_REGEX, (match, ns: string, field: string) => {
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
      if (field === "outputs_dir") {
        return run.outputsDir ?? match;
      }
      if (field === "base_branch") {
        return run.base_branch ?? match;
      }
      if (field === "feedback") {
        // The human answer a resumed run carries (ADR 0042). The EMPTY STRING
        // rather than a pass-through when absent: unlike `cwd` or
        // `base_branch`, a step binding this token is asking "what did the
        // human say", and "nobody said anything" is a real answer to that —
        // handing the literal `{{ run.feedback }}` to the model instead would
        // read as an instruction. Same convention as a missing `inputs.*` key.
        return run.feedback ?? "";
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
  return out;
}

/**
 * Load-time (step-inlining) substitution: resolve `{{ inputs.<field> }}`
 * tokens only. Every other token — `brief.*`, `run.*`, `priorResults.*`,
 * unknown namespaces — belongs to dispatch time and survives verbatim,
 * including a token an input value carries into the step body. The second
 * pass resolves an `inputs.*` token that an input value itself contained,
 * matching `substitute`'s two-pass shape.
 *
 * Calling `substitute(v, { inputs })` here instead is the #33 defect: its
 * prior-results pass runs unconditionally, so a `{{ priorResults.* }}`
 * token supplied through a `uses:` node's `inputs:` resolved against an
 * empty map and was erased to "" before the run began.
 */
export function substituteInputs(input: string, inputs: Record<string, unknown>): string {
  const once = (s: string): string =>
    s.replace(TOKEN_REGEX, (match, ns: string, field: string) => {
      if (ns !== "inputs") return match;
      if (!Object.hasOwn(inputs, field)) return "";
      return stringifyInputValue(inputs[field]);
    });
  const first = once(input);
  if (first === input) return first;
  return once(first);
}

function substitutePriorResults(input: string, subs: Substitutions): string {
  if (!PRIOR_RESULTS_TOKEN_REGEX.test(input)) return input;
  // Reset lastIndex on the global regex before re-using.
  PRIOR_RESULTS_TOKEN_REGEX.lastIndex = 0;
  return input.replace(
    PRIOR_RESULTS_TOKEN_REGEX,
    (_match, nodeId: string, outputKey: string, readSuffix: string | undefined) => {
      const isRead = readSuffix === ":read";
      const map = subs.priorResults;
      const result = map?.get(nodeId);
      const outputs: NodeOutputIndex | null | undefined = result?.outputs ?? null;
      const entry = outputs ? outputs[outputKey] : undefined;
      if (!entry) {
        // Not found → empty string (consistent with optional brief/inputs).
        return "";
      }
      if (!isRead) {
        return entry.path;
      }
      // :read suffix — directory outputs are not valid.
      if (entry.type === "directory") {
        throw new TemplateSubstitutionError(
          `:read is not valid for directory outputs (node "${nodeId}", output "${outputKey}")`,
        );
      }
      // Check size cap before reading.
      let size = entry.size;
      try {
        const s = statSync(entry.path);
        size = s.size;
      } catch (err) {
        throw new TemplateSubstitutionError(
          `failed to read output for :read substitution (node "${nodeId}", output "${outputKey}", path "${entry.path}"): ${(err as Error).message}`,
        );
      }
      if (size > PRIOR_RESULTS_READ_CAP) {
        throw new TemplateSubstitutionError(
          `output too large for :read substitution (node "${nodeId}", output "${outputKey}", size ${size} bytes, cap ${PRIOR_RESULTS_READ_CAP} bytes)`,
        );
      }
      try {
        return readFileSync(entry.path, "utf8");
      } catch (err) {
        throw new TemplateSubstitutionError(
          `failed to read output for :read substitution (node "${nodeId}", output "${outputKey}", path "${entry.path}"): ${(err as Error).message}`,
        );
      }
    },
  );
}

/**
 * `{{ priorResults.<id>.status }}` → `succeeded` | `failed`;
 * `{{ priorResults.<id>.reason }}` → the recorded reason string. A node
 * with no prior result in this run, or a null reason, substitutes the
 * empty string — the same convention as a missing output key.
 */
function substitutePriorResultFields(input: string, subs: Substitutions): string {
  if (!PRIOR_RESULTS_FIELD_TOKEN_REGEX.test(input)) return input;
  PRIOR_RESULTS_FIELD_TOKEN_REGEX.lastIndex = 0;
  return input.replace(PRIOR_RESULTS_FIELD_TOKEN_REGEX, (_match, nodeId: string, field: string) => {
    const result = subs.priorResults?.get(nodeId);
    if (!result) return "";
    if (field === "status") return result.status;
    return result.reason ?? "";
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

export class TemplateSubstitutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateSubstitutionError";
  }
}
