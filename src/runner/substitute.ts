import { readFileSync, statSync } from "node:fs";
import type { Brief } from "../brief/loader.js";
import type { NodeResult } from "../executor/types.js";
import type { NodeOutputIndex } from "../factory/schema.js";

const TOKEN_REGEX = /\{\{\s*(brief|run|inputs)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

const PRIOR_RESULTS_TOKEN_REGEX =
  /\{\{\s*priorResults\.([a-zA-Z_][a-zA-Z0-9_-]*)\.outputs\.([a-zA-Z_][a-zA-Z0-9_]*)(:read)?\s*\}\}/g;

export const PRIOR_RESULTS_READ_CAP = 64 * 1024;

export interface Substitutions {
  brief?: Brief;
  run?: { cwd?: string; outputsDir?: string };
  /** Per-node inputs map produced at step inlining time. Absent on inline
   * nodes (never inlined from a step). When absent, `{{ inputs.* }}`
   * tokens pass through verbatim. */
  inputs?: Record<string, unknown>;
  /** Latest-iteration NodeResult per node id, used to resolve
   * `{{ priorResults.<id>.outputs.<key>[:read] }}` tokens. */
  priorResults?: ReadonlyMap<string, NodeResult>;
}

/**
 * Substitute `{{ <ns>.<field> }}` tokens (ns ∈ {brief, run, inputs}) and
 * `{{ priorResults.<id>.outputs.<key>[:read] }}` tokens in `input` using
 * values from `subs`. Unknown ns or unknown fields under a known ns pass
 * through verbatim.
 */
export function substitute(input: string, subs: Substitutions): string {
  const first = substituteOnce(input, subs);
  if (first === input) return first;
  return substituteOnce(first, subs);
}

function substituteOnce(input: string, subs: Substitutions): string {
  let out = substitutePriorResults(input, subs);
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
