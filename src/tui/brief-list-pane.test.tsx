import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  type BriefListState,
  autorunReducer,
  createInitialBriefListState,
} from "./autorun-reducer.js";
import { BriefListPane } from "./brief-list-pane.js";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs.js";

function withAllStatuses(): BriefListState {
  let s = createInitialBriefListState();
  s = autorunReducer(s, { kind: "started", ts: 0, change: "queued-row" });
  // override to queued (the canonical pre-schedule status)
  s = {
    ...s,
    briefs: s.briefs.map((b) => (b.change === "queued-row" ? { ...b, status: "queued" } : b)),
  };
  s = autorunReducer(s, { kind: "started", ts: 0, change: "running-row" });
  s = autorunReducer(s, { kind: "started", ts: 0, change: "succeeded-row" });
  s = autorunReducer(s, {
    kind: "completed",
    ts: 1,
    change: "succeeded-row",
    status: "succeeded",
  });
  s = autorunReducer(s, { kind: "started", ts: 0, change: "failed-row" });
  s = autorunReducer(s, { kind: "completed", ts: 1, change: "failed-row", status: "failed" });
  s = autorunReducer(s, { kind: "skipped", ts: 0, change: "skipped-row", reason: "blocked" });
  return s;
}

describe("BriefListPane", () => {
  it("renders all five statuses with Unicode glyphs", () => {
    const state = withAllStatuses();
    const { lastFrame } = render(<BriefListPane state={state} glyphs={UNICODE_GLYPHS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("queued-row");
    expect(frame).toContain("running-row");
    expect(frame).toContain("succeeded-row");
    expect(frame).toContain("failed-row");
    expect(frame).toContain("skipped-row");
    // The skipped glyph (or its skip-reason suffix) appears.
    expect(frame).toMatch(/blocked/);
    // Queued glyph (○) appears at least once.
    expect(frame).toContain(UNICODE_GLYPHS.pending);
  });

  it("renders all five statuses with ASCII glyphs", () => {
    const state = withAllStatuses();
    const { lastFrame } = render(<BriefListPane state={state} glyphs={ASCII_GLYPHS} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("queued-row");
    expect(frame).toContain("succeeded-row");
    expect(frame).toContain("failed-row");
    expect(frame).toContain("skipped-row");
    // ASCII skipped glyph (~) appears
    expect(frame).toContain("~");
  });

  it("renders the empty state hint when no briefs are present", () => {
    const state = createInitialBriefListState();
    const { lastFrame } = render(<BriefListPane state={state} glyphs={UNICODE_GLYPHS} />);
    expect(lastFrame() ?? "").toContain("no briefs yet");
  });
});
