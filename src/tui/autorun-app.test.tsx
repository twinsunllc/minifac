import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { EmittedEvent } from "../executor/types.js";
import { AutorunApp, type AutorunHandlers } from "./autorun-app.js";
import {
  type BriefListState,
  autorunReducer,
  createInitialBriefListState,
  makeRunStateSlot,
} from "./autorun-reducer.js";
import { UNICODE_GLYPHS } from "./glyphs.js";
import { runReducer } from "./reducer.js";

function noopHandlers(): AutorunHandlers {
  return {
    dispatchAutorun: () => undefined,
    dispatchRun: () => undefined,
    onRawSwitch: () => undefined,
    onQuit: () => undefined,
  };
}

function renderApp(
  state: BriefListState,
  opts: { columns?: number; rows?: number; inFlight?: number } = {},
) {
  return render(
    <AutorunApp
      state={state}
      glyphs={UNICODE_GLYPHS}
      handlers={noopHandlers()}
      inputEnabled={false}
      columns={opts.columns ?? 120}
      rows={opts.rows ?? 40}
      inFlight={opts.inFlight ?? 0}
    />,
  );
}

function withAllStatuses(): BriefListState {
  let s = createInitialBriefListState({ watchBasename: "inputs", maxConcurrent: 2 });
  s = autorunReducer(s, { kind: "started", ts: 0, change: "queued-row" });
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

describe("AutorunApp", () => {
  it("renders the empty-state hint when no briefs are present", () => {
    const state = createInitialBriefListState({ watchBasename: "inputs", maxConcurrent: 2 });
    const { lastFrame } = renderApp(state);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Press");
    expect(frame).toContain("select a brief");
    expect(frame).toContain("minifac autorun");
    expect(frame).toContain("in-flight=0/2");
  });

  it("renders all five brief statuses in the brief-list pane", () => {
    const state = withAllStatuses();
    const { lastFrame } = renderApp(state);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("queued-row");
    expect(frame).toContain("running-row");
    expect(frame).toContain("succeeded-row");
    expect(frame).toContain("failed-row");
    expect(frame).toContain("skipped-row");
  });

  it("renders the drilled-in state with brief-list on left and run view on right", () => {
    let s = withAllStatuses();
    const runState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "succeeded-row" },
      nodeIds: ["propose", "apply"],
    });
    s = autorunReducer(s, { kind: "set-run-state", change: "succeeded-row", runState });
    // select the succeeded brief (index 2) and enter
    s = autorunReducer(s, { kind: "select-brief-next" });
    s = autorunReducer(s, { kind: "select-brief-next" });
    s = autorunReducer(s, { kind: "enter-brief" });
    expect(s.focus).toBe("run-view");
    const { lastFrame } = renderApp(s);
    const frame = lastFrame() ?? "";
    // Brief list still visible on the left
    expect(frame).toContain("succeeded-row");
    // Run view nodes visible on the right
    expect(frame).toContain("propose");
    expect(frame).toContain("apply");
    // Header shows brief + factory
    expect(frame).toContain("sdd");
  });

  it("sub-80x24 collapses to single pane: brief list when focus=brief-list", () => {
    const state = withAllStatuses();
    const { lastFrame } = renderApp(state, { columns: 60, rows: 20 });
    const frame = lastFrame() ?? "";
    expect(frame).toContain("queued-row");
    // Empty-state hint should NOT appear (we're showing the brief list, not the run view)
    expect(frame).not.toContain("Enter to drill in");
  });

  it("sub-80x24 collapses to log pane only when focus=run-view", () => {
    let s = withAllStatuses();
    const runState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "succeeded-row" },
      nodeIds: ["propose"],
    });
    s = autorunReducer(s, { kind: "set-run-state", change: "succeeded-row", runState });
    s = autorunReducer(s, { kind: "select-brief-next" });
    s = autorunReducer(s, { kind: "select-brief-next" });
    s = autorunReducer(s, { kind: "enter-brief" });
    const { lastFrame } = renderApp(s, { columns: 60, rows: 20 });
    const frame = lastFrame() ?? "";
    // Brief list rows are hidden in compact + focus=run-view
    // (we only render the log pane in this case)
    expect(frame).toMatch(/no events yet/);
  });

  it("renders the help overlay when showHelp is true", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, { kind: "toggle-help" });
    const { lastFrame } = renderApp(s);
    expect(lastFrame() ?? "").toContain("hotkeys");
  });

  it("renders the mid-drain hotkey hint when quitConfirm is true and runs are in flight", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, { kind: "started", ts: 0, change: "foo" });
    s = autorunReducer(s, { kind: "request-quit" });
    const { lastFrame } = renderApp(s, { inFlight: 1 });
    expect(lastFrame() ?? "").toContain("Draining");
    expect(lastFrame() ?? "").toContain("q again");
  });

  it("uses the autorun-level hotkey hint when focus=brief-list", () => {
    const state = withAllStatuses();
    const { lastFrame } = renderApp(state);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Enter drill in");
  });

  it("uses the run-mode-style hotkey hint when focus=run-view", () => {
    let s = withAllStatuses();
    const runState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "succeeded-row" },
      nodeIds: ["propose"],
    });
    s = autorunReducer(s, { kind: "set-run-state", change: "succeeded-row", runState });
    s = autorunReducer(s, { kind: "select-brief-next" });
    s = autorunReducer(s, { kind: "select-brief-next" });
    s = autorunReducer(s, { kind: "enter-brief" });
    const { lastFrame } = renderApp(s);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Esc back to briefs");
  });

  it("renders propagating run events via the embedded RunState", () => {
    let s = createInitialBriefListState({ watchBasename: "inputs", maxConcurrent: 1 });
    s = autorunReducer(s, { kind: "started", ts: 0, change: "foo" });
    let runState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "foo" },
      nodeIds: ["only"],
    });
    const entry: EmittedEvent = {
      nodeId: "only",
      iteration: 1,
      emittedAt: 0,
      event: { kind: "stdout", line: '{"type":"system","subtype":"init"}' },
    };
    runState = runReducer(runState, entry);
    s = autorunReducer(s, { kind: "set-run-state", change: "foo", runState });
    s = autorunReducer(s, { kind: "enter-brief" });
    const { lastFrame } = renderApp(s);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("only");
  });
});
