import type { Brief } from "../brief/loader.js";

const TOKEN_REGEX = /\{\{\s*(brief|run)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export interface Substitutions {
  brief?: Brief;
  run?: { cwd: string };
}

/**
 * Substitute `{{ <ns>.<field> }}` tokens (ns ∈ {brief, run}) in `input` using
 * values from `subs`. Unknown ns or unknown fields under a known ns pass
 * through verbatim. Optional brief fields (`base_branch`, `model`)
 * substitute the empty string when absent on the brief. `run.cwd` resolves
 * to `subs.run?.cwd` when in scope; other `run.*` identifiers pass through.
 */
export function substitute(input: string, subs: Substitutions): string {
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
      if (field === "cwd") return run.cwd;
      return match;
    }
    return match;
  });
}

/**
 * Back-compat shim for callers that still substitute only brief tokens.
 * New callers should use `substitute` directly with a `Substitutions` record.
 */
export function substituteBriefTokens(prompt: string, brief: Brief): string {
  return substitute(prompt, { brief });
}
