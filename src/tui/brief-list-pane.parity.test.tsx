import chalk from "chalk";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

// Force chalk/ink to emit ANSI color codes so this test can verify color
// parity. Without this, ink-testing-library's non-TTY mock causes chalk to
// strip colors and we can only see the glyph chars.
chalk.level = 3;
import {
  type BriefListState,
  autorunReducer,
  createInitialBriefListState,
} from "./autorun-reducer.js";
import { BriefListPane } from "./brief-list-pane.js";
import { UNICODE_GLYPHS } from "./glyphs.js";
import { type RunState, runReducer } from "./reducer.js";
import { StatusPane } from "./status-pane.js";

/**
 * Verifies the brief-list pane and the run-tui status pane render the four
 * shared statuses (queued↔pending, running, succeeded, failed) with the
 * same glyph + the same color tokens. The skipped status is brief-only
 * (no run-tui node analog) and is asserted by `brief-list-pane.test.tsx`.
 */

interface RowSignature {
  glyph: string;
  glyphColor: string;
  labelColor: string;
}

// Ink applies colors via ANSI SGR escape sequences. `chalk` uses these
// codes for the colors we hand it: yellow=33, green=32, red=31, gray=90.
// The label is colored separately from the glyph, but with the same color,
// so each colored chunk is a `\x1b[<n>m...\x1b[39m` span. We extract the
// glyph (first colored chunk) and the label (chunk containing the row id).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences require ESC (0x1b)
const SGR_RE = /\x1b\[(\d+)m([^\x1b]*)/g;

function extractRowSignature(frame: string, label: string): RowSignature {
  const rowLine = frame.split("\n").find((l) => l.includes(label));
  if (!rowLine) {
    throw new Error(`row containing "${label}" not found in:\n${frame}`);
  }
  const chunks: Array<{ code: string; text: string }> = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration
  while ((m = SGR_RE.exec(rowLine)) !== null) {
    const code = m[1];
    const text = m[2];
    if (code !== undefined && text !== undefined) {
      chunks.push({ code, text });
    }
  }
  // Find the first colored chunk after the leading marker (▸ / space) and
  // before the label chunk. The glyph chunk holds a single visible char.
  const labelIdx = chunks.findIndex((c) => c.text.includes(label));
  if (labelIdx <= 0) {
    throw new Error(`label chunk for "${label}" not found in row:\n${rowLine}`);
  }
  const labelChunk = chunks[labelIdx];
  // Walk back from the label to find the most recent colored (non-reset)
  // chunk whose visible text is non-empty — that's the glyph.
  let glyphChunk: { code: string; text: string } | undefined;
  for (let i = labelIdx - 1; i >= 0; i--) {
    const c = chunks[i];
    if (!c) continue;
    if (c.code === "39" || c.code === "0") continue;
    if (c.text.trim().length === 0) continue;
    glyphChunk = c;
    break;
  }
  if (!glyphChunk || !labelChunk) {
    throw new Error(`could not locate glyph + label chunks in:\n${rowLine}`);
  }
  return {
    glyph: glyphChunk.text.trim(),
    glyphColor: glyphChunk.code,
    labelColor: labelChunk.code,
  };
}

function briefStateFor(status: "queued" | "running" | "succeeded" | "failed"): BriefListState {
  const change = "row";
  let s = createInitialBriefListState();
  s = autorunReducer(s, { kind: "started", ts: 0, change });
  if (status === "queued") {
    s = {
      ...s,
      briefs: s.briefs.map((b) => (b.change === change ? { ...b, status: "queued" } : b)),
    };
  } else if (status === "succeeded") {
    s = autorunReducer(s, { kind: "completed", ts: 1, change, status: "succeeded" });
  } else if (status === "failed") {
    s = autorunReducer(s, { kind: "completed", ts: 1, change, status: "failed" });
  }
  // running is the default after `started`
  return s;
}

function runStateFor(status: "pending" | "running" | "succeeded" | "failed"): RunState {
  const base: RunState = {
    factory: { name: "sdd" },
    branchName: null,
    nodes: [
      {
        id: "row",
        status,
        iteration: status === "pending" ? 0 : 1,
        iterations: [],
      },
    ],
    selectedNodeId: "row",
    selectedIteration: 1,
    followMode: false,
    highlightIndex: 0,
    detailsOpen: new Set<string>(),
    scrollOffset: 0,
    showHelp: false,
    showQuitPrompt: false,
    tick: 0,
  };
  return base;
}

const SHARED_STATUSES: Array<{
  briefStatus: "queued" | "running" | "succeeded" | "failed";
  nodeStatus: "pending" | "running" | "succeeded" | "failed";
}> = [
  { briefStatus: "queued", nodeStatus: "pending" },
  { briefStatus: "running", nodeStatus: "running" },
  { briefStatus: "succeeded", nodeStatus: "succeeded" },
  { briefStatus: "failed", nodeStatus: "failed" },
];

describe("BriefListPane ↔ StatusPane glyph + color parity", () => {
  for (const { briefStatus, nodeStatus } of SHARED_STATUSES) {
    it(`matches glyph and color for ${briefStatus}/${nodeStatus}`, () => {
      const briefFrame =
        render(
          <BriefListPane state={briefStateFor(briefStatus)} glyphs={UNICODE_GLYPHS} />,
        ).lastFrame() ?? "";
      const runFrame =
        render(
          <StatusPane state={runStateFor(nodeStatus)} glyphs={UNICODE_GLYPHS} />,
        ).lastFrame() ?? "";

      const briefSig = extractRowSignature(briefFrame, "row");
      const runSig = extractRowSignature(runFrame, "row");

      expect(briefSig.glyph).toBe(runSig.glyph);
      expect(briefSig.glyphColor).toBe(runSig.glyphColor);
      expect(briefSig.labelColor).toBe(runSig.labelColor);
    });
  }

  it("excludes skipped — no run-tui node analog exists", () => {
    // Sanity: brief-list still renders the skipped glyph + gray color
    // (covered fully by the existing brief-list-pane.test.tsx scenarios).
    let s = createInitialBriefListState();
    s = autorunReducer(s, { kind: "skipped", ts: 0, change: "row", reason: "blocked" });
    const frame = render(<BriefListPane state={s} glyphs={UNICODE_GLYPHS} />).lastFrame() ?? "";
    expect(frame).toContain(UNICODE_GLYPHS.skipped);
    expect(frame).toContain("row");
    expect(frame).toContain("blocked");
  });
});
