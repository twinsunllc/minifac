import { readFileSync, statSync } from "node:fs";
import type { Brief } from "../brief/loader.js";
import type { NodeResult } from "../executor/types.js";
import type { NodeOutputIndex } from "../factory/schema.js";
import type { SplitIntegrationState, SplitState } from "./resume.js";

/** `{{ <ns>.<field>[.<key>...] }}`. The optional dotted sub-path (group 3)
 * resolves only under `run.split` and `run.split_integration` (ADR 0044);
 * any other token that carries one passes through verbatim, as it did
 * before the grammar allowed it. */
const TOKEN_REGEX =
  /\{\{\s*(brief|run|inputs)\.([a-zA-Z_][a-zA-Z0-9_]*)((?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g;

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
  run?: {
    cwd?: string;
    outputsDir?: string;
    base_branch?: string;
    feedback?: string;
    resumed_at?: string;
    follow_up?: string;
    prior_asks?: string;
    /** ADR 0044. `null` (or absent) when the run is not a split child. */
    split?: SplitState | null;
    /** ADR 0044. `null` (or absent) except on a resumed split parent. */
    split_integration?: SplitIntegrationState | null;
  };
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

/** Output of {@link substituteForShell}. */
export interface ShellSubstitution {
  /** `input` with every resolved token replaced by `"${MINIFAC_TOKEN_<n>}"`. */
  text: string;
  /** `MINIFAC_TOKEN_<n>` → the token's rendered value. */
  env: Record<string, string>;
}

/**
 * Shell-safe substitution for a command executor's `run` (ADR 0050). Same
 * token grammar, pass-through rules and {@link TemplateSubstitutionError}
 * cases as {@link substitute}, but a resolved token is never spliced into the
 * text: it becomes a double-quoted reference to an environment variable, and
 * the rendered value goes in `env` for the caller to hand the child. A value
 * therefore reaches `/bin/sh` as data, whatever quotes, `$()` or newlines it
 * holds. A token left verbatim (unknown namespace or field) stays verbatim.
 *
 * `substitute`'s second pass resolves a token a value itself carried (an
 * input defaulting to `{{ run.outputs_dir }}`); here that pass runs on the
 * value, so the env holds the same text `substitute` would have spliced.
 */
export function substituteForShell(input: string, subs: Substitutions): ShellSubstitution {
  const env: Record<string, string> = {};
  let n = 0;
  const text = substituteOnce(input, subs, (value) => {
    const name = `MINIFAC_TOKEN_${n++}`;
    env[name] = substituteOnce(value, subs);
    return `"\${${name}}"`;
  });
  return { text, env };
}

/** How a resolved token's value enters the output: as-is for `substitute`,
 * as an env reference for `substituteForShell`. Pass-throughs never reach it. */
type Emit = (value: string) => string;

const emitValue: Emit = (value) => value;

function substituteOnce(input: string, subs: Substitutions, emit: Emit = emitValue): string {
  let out = substitutePriorResults(input, subs, emit);
  out = substitutePriorResultFields(out, subs, emit);
  out = out.replace(TOKEN_REGEX, (match, ns: string, field: string, subPath: string) => {
    const value = resolveToken(subs, ns, field, subPath);
    return value === null ? match : emit(value);
  });
  return out;
}

/** The rendered value of one `brief.*` / `run.*` / `inputs.*` token, or `null`
 * when the token passes through verbatim. */
function resolveToken(
  subs: Substitutions,
  ns: string,
  field: string,
  subPath: string,
): string | null {
  if (ns === "run" && (field === "split" || field === "split_integration")) {
    const run = subs.run;
    if (!run) return null;
    return renderRunContext(run[field] ?? null, subPath);
  }
  // Only the two run-context objects above have keys to walk.
  if (subPath.length > 0) return null;
  if (ns === "brief") {
    const brief = subs.brief;
    if (!brief) return null;
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
        return null;
    }
  }
  if (ns === "run") {
    const run = subs.run;
    if (!run) return null;
    if (field === "cwd") {
      return run.cwd ?? null;
    }
    if (field === "outputs_dir") {
      return run.outputsDir ?? null;
    }
    if (field === "base_branch") {
      return run.base_branch ?? null;
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
    // ADR 0043. Same empty-not-verbatim convention as `feedback`, each with
    // the value that means "none": no resume seed, not a follow-up, no
    // prior asks.
    if (field === "resumed_at") {
      return run.resumed_at ?? "";
    }
    if (field === "follow_up") {
      return run.follow_up ?? "false";
    }
    if (field === "prior_asks") {
      return run.prior_asks ?? "[]";
    }
    return null;
  }
  if (ns === "inputs") {
    if (subs.inputs === undefined) return null;
    if (!Object.hasOwn(subs.inputs, field)) return "";
    return stringifyInputValue(subs.inputs[field]);
  }
  return null;
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
    s.replace(TOKEN_REGEX, (match, ns: string, field: string, subPath: string) => {
      if (ns !== "inputs" || subPath.length > 0) return match;
      if (!Object.hasOwn(inputs, field)) return "";
      return stringifyInputValue(inputs[field]);
    });
  const first = once(input);
  if (first === input) return first;
  return once(first);
}

function substitutePriorResults(input: string, subs: Substitutions, emit: Emit): string {
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
        return emit("");
      }
      if (!isRead) {
        return emit(entry.path);
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
      let content: string;
      try {
        content = readFileSync(entry.path, "utf8");
      } catch (err) {
        throw new TemplateSubstitutionError(
          `failed to read output for :read substitution (node "${nodeId}", output "${outputKey}", path "${entry.path}"): ${(err as Error).message}`,
        );
      }
      return emit(content);
    },
  );
}

/**
 * `{{ priorResults.<id>.status }}` → `succeeded` | `failed`;
 * `{{ priorResults.<id>.reason }}` → the recorded reason string. A node
 * with no prior result in this run, or a null reason, substitutes the
 * empty string — the same convention as a missing output key.
 */
function substitutePriorResultFields(input: string, subs: Substitutions, emit: Emit): string {
  if (!PRIOR_RESULTS_FIELD_TOKEN_REGEX.test(input)) return input;
  PRIOR_RESULTS_FIELD_TOKEN_REGEX.lastIndex = 0;
  return input.replace(PRIOR_RESULTS_FIELD_TOKEN_REGEX, (_match, nodeId: string, field: string) => {
    const result = subs.priorResults?.get(nodeId);
    if (!result) return emit("");
    if (field === "status") return emit(result.status);
    return emit(result.reason ?? "");
  });
}

/**
 * `{{ run.split[.<key>...] }}` / `{{ run.split_integration[.<key>...] }}`
 * (ADR 0044). With no sub-path, the whole object as JSON, or `null` when the
 * run has none. With one, walk plain-object keys: a string renders as-is, a
 * number or boolean via `String`, an object or array as JSON. A missing key,
 * a null value, an absent object, or a step through a non-object (an array
 * included, so there is no indexing) renders the empty string: the
 * empty-not-verbatim convention of `run.feedback`.
 */
function renderRunContext(
  value: SplitState | SplitIntegrationState | null,
  subPath: string,
): string {
  if (subPath.length === 0) return JSON.stringify(value);
  let current: unknown = value;
  for (const key of subPath.slice(1).split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return "";
    if (!Object.hasOwn(current, key)) return "";
    current = (current as Record<string, unknown>)[key];
  }
  return stringifyInputValue(current);
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
