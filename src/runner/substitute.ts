import type { Brief } from "../brief/loader.js";

const TOKEN_REGEX = /\{\{\s*brief\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitute `{{ brief.<field> }}` tokens in a prompt string using values from
 * the given brief. Unknown identifiers pass through verbatim. Optional fields
 * (`base_branch`, `model`) substitute the empty string when absent.
 */
export function substituteBriefTokens(prompt: string, brief: Brief): string {
  return prompt.replace(TOKEN_REGEX, (match, field: string) => {
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
  });
}
