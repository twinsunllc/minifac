import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { EmittedEvent } from "../executor/types.js";
import { RunApp } from "./app.js";
import { AutorunApp, type AutorunHandlers } from "./autorun-app.js";
import {
  type BriefListState,
  autorunReducer,
  createInitialBriefListState,
  makeRunStateSlot,
} from "./autorun-reducer.js";
import { UNICODE_GLYPHS } from "./glyphs.js";
import { type RunState, runReducer } from "./reducer.js";

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

  it("drilled-in body renders three vertical regions: briefs | nodes | events", () => {
    // Build a brief-list with two briefs; the second has a populated RunState
    // with two nodes ("propose" running, "apply" pending) and at least one
    // emitted event in the propose iteration.
    let s = createInitialBriefListState({ watchBasename: "inputs", maxConcurrent: 2 });
    s = autorunReducer(s, { kind: "started", ts: 0, change: "alpha" });
    s = autorunReducer(s, { kind: "started", ts: 0, change: "beta" });
    let runState: RunState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "beta" },
      nodeIds: ["propose", "apply"],
    });
    const entry: EmittedEvent = {
      nodeId: "propose",
      iteration: 1,
      emittedAt: 0,
      event: {
        kind: "stdout",
        line: '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking…"}]}}',
      },
    };
    runState = runReducer(runState, entry);
    s = autorunReducer(s, { kind: "set-run-state", change: "beta", runState });
    s = autorunReducer(s, { kind: "select-brief-next" });
    s = autorunReducer(s, { kind: "enter-brief" });
    expect(s.focus).toBe("run-view");

    const { lastFrame } = renderApp(s, { columns: 100, rows: 30 });
    const frame = lastFrame() ?? "";

    // Three visible regions, left to right:
    //   (1) brief-list pane: both brief change names appear
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    //   (2) nodes pane (24 cols, middle): both node ids appear
    expect(frame).toContain("propose");
    expect(frame).toContain("apply");
    //   (3) log pane (rightmost, flex): rendered event content appears
    expect(frame).toContain("thinking");

    // The drilled-in body MUST be three columns. If the right region were
    // stacked vertically (the pre-fix bug), the "propose" and "thinking"
    // substrings would not occupy the same terminal row.
    const lines = frame.split("\n");
    const propLine = lines.findIndex((l) => l.includes("propose"));
    const thinkingLine = lines.findIndex((l) => l.includes("thinking"));
    expect(propLine).toBeGreaterThanOrEqual(0);
    expect(thinkingLine).toBeGreaterThanOrEqual(0);
    // The "thinking" line should be at or above the bottom of the nodes
    // listing (i.e. the log pane shares a row range with the nodes pane).
    // We check that both fall inside the same body region by allowing them
    // to be within a few rows of each other rather than separated by the
    // full nodes-pane height (which would indicate vertical stacking).
    expect(Math.abs(propLine - thinkingLine)).toBeLessThan(6);

    // Snapshot pins the exact three-column drilled-in frame so a
    // regression to two columns would surface in CI as a snapshot diff.
    // Regions, left to right: brief list (24) | nodes pane (24) | log pane (flex).
    expect(frame).toMatchSnapshot();

    // Snapshot-independent invariant: the drilled-in body row MUST contain
    // exactly two vertical-rule glyphs (briefs|nodes and nodes|events). If a
    // future snapshot regeneration captures a one-rule (two-column) bug, this
    // assertion still fails.
    const bodyLine =
      lines.find((l) => l.includes("propose") && l.includes("alpha")) ??
      lines.find((l) => l.includes("propose")) ??
      "";
    const interiorRuleCount = (bodyLine.match(/│/g)?.length ?? 0) - 2;
    expect(interiorRuleCount).toBe(2);
  });

  it("drilled-in right region mirrors RunApp body for the same RunState", () => {
    // Build identical RunState for both surfaces.
    let runState: RunState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "beta" },
      nodeIds: ["propose", "apply"],
    });
    runState = runReducer(runState, {
      nodeId: "propose",
      iteration: 1,
      emittedAt: 0,
      event: {
        kind: "stdout",
        line: '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      },
    });

    let s = createInitialBriefListState({ watchBasename: "inputs", maxConcurrent: 1 });
    s = autorunReducer(s, { kind: "started", ts: 0, change: "beta" });
    s = autorunReducer(s, { kind: "set-run-state", change: "beta", runState });
    s = autorunReducer(s, { kind: "enter-brief" });

    const autorunFrame = renderApp(s, { columns: 100, rows: 30 }).lastFrame() ?? "";
    const runFrame =
      render(
        <RunApp
          state={runState}
          glyphs={UNICODE_GLYPHS}
          handlers={{
            dispatch: () => undefined,
            onRawSwitch: () => undefined,
            onQuit: () => undefined,
            onMerge: () => undefined,
          }}
          inputEnabled={false}
          columns={100}
          rows={30}
        />,
      ).lastFrame() ?? "";

    // Both surfaces should show the same node ids and the same log line.
    for (const needle of ["propose", "apply", "hello"]) {
      expect(autorunFrame).toContain(needle);
      expect(runFrame).toContain(needle);
    }
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
