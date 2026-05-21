import type { NodeStatus } from "./reducer.js";

export type GlyphSet = "unicode" | "ascii";

export interface StatusGlyphs {
  pending: string;
  running: string;
  succeeded: string;
  failed: string;
  retrying: string;
  arrow: string;
  check: string;
  cross: string;
  spinnerFrames: readonly string[];
}

export const UNICODE_GLYPHS: StatusGlyphs = {
  pending: "○",
  running: "◔",
  succeeded: "●",
  failed: "●",
  retrying: "↻",
  arrow: "→",
  check: "✓",
  cross: "✗",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

export const ASCII_GLYPHS: StatusGlyphs = {
  pending: ".",
  running: "*",
  succeeded: "o",
  failed: "!",
  retrying: "*",
  arrow: ">",
  check: "+",
  cross: "-",
  spinnerFrames: ["|", "/", "-", "\\"],
};

const UTF8_RE = /utf-?8/i;

export interface GlyphEnv {
  LANG?: string | undefined;
  LC_ALL?: string | undefined;
  LC_CTYPE?: string | undefined;
}

export function pickGlyphSet(env: GlyphEnv): GlyphSet {
  const all = `${env.LC_ALL ?? ""} ${env.LANG ?? ""} ${env.LC_CTYPE ?? ""}`;
  return UTF8_RE.test(all) ? "unicode" : "ascii";
}

export function glyphsFor(set: GlyphSet): StatusGlyphs {
  return set === "unicode" ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

/** Pick a single status glyph for a node row. */
export function statusGlyph(glyphs: StatusGlyphs, status: NodeStatus): string {
  switch (status) {
    case "pending":
      return glyphs.pending;
    case "running":
      return glyphs.running;
    case "succeeded":
      return glyphs.succeeded;
    case "failed":
      return glyphs.failed;
    case "retrying":
      return glyphs.retrying;
  }
}
