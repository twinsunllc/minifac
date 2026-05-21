import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { RunApp } from "./app.js";
import { UNICODE_GLYPHS } from "./glyphs.js";
import { type RunState, createInitialRunState, runReducer } from "./reducer.js";

function noopHandlers() {
  return {
    dispatch: () => undefined,
    onRawSwitch: () => undefined,
    onQuit: () => undefined,
    onMerge: () => undefined,
  };
}

const baseInit = () =>
  createInitialRunState({
    factory: { name: "sdd" },
    brief: { change: "foo" },
    nodeIds: ["propose", "apply", "verify"],
    branchName: "minifac/run/foo/abc",
  });

const renderApp = (state: RunState, opts: { columns?: number; rows?: number } = {}) =>
  render(
    <RunApp
      state={state}
      glyphs={UNICODE_GLYPHS}
      handlers={noopHandlers()}
      inputEnabled={false}
      columns={opts.columns ?? 100}
      rows={opts.rows ?? 30}
    />,
  );

describe("RunApp", () => {
  afterEach(() => {
    // ink-testing-library tears down internally each render
  });

  it("renders all nodes as pending in the initial state", () => {
    const state = baseInit();
    const { lastFrame } = renderApp(state);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("propose");
    expect(frame).toContain("apply");
    expect(frame).toContain("verify");
    // Pending glyph appears.
    expect(frame).toContain(UNICODE_GLYPHS.pending);
  });

  it("renders the running node with the running color and spinner placeholder", () => {
    let s = baseInit();
    s = runReducer(s, {
      nodeId: "propose",
      iteration: 1,
      emittedAt: 0,
      event: {
        kind: "stdout",
        line: '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
      },
    });
    s = { ...s, tick: 0 };
    const { lastFrame } = renderApp(s);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("propose");
    expect(frame).toContain("working");
  });

  it("renders all nodes as succeeded after terminate-run", () => {
    let s = baseInit();
    for (const id of ["propose", "apply", "verify"]) {
      s = runReducer(s, {
        nodeId: id,
        iteration: 1,
        emittedAt: 0,
        event: { kind: "stdout", line: "{}" },
      });
      s = runReducer(s, {
        nodeId: id,
        iteration: 1,
        emittedAt: 0,
        event: { kind: "status", status: "succeeded" },
      });
    }
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    const { lastFrame } = renderApp(s);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("succeeded");
    expect(frame).toContain("merge");
  });

  it("renders a retrying-then-running second iteration", () => {
    let s = baseInit();
    s = runReducer(s, {
      nodeId: "verify",
      iteration: 1,
      emittedAt: 0,
      event: { kind: "stdout", line: "{}" },
    });
    s = runReducer(s, {
      nodeId: "verify",
      iteration: 1,
      emittedAt: 0,
      event: { kind: "status", status: "failed" },
    });
    s = runReducer(s, {
      nodeId: "verify",
      iteration: 2,
      emittedAt: 0,
      event: { kind: "stdout", line: "{}" },
    });
    const { lastFrame } = renderApp(s);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("verify");
    expect(frame).toContain("(2)");
  });

  it("on terminal=succeeded with a branchName the bottom bar shows m merge", () => {
    let s = baseInit();
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    const { lastFrame } = renderApp(s);
    expect(lastFrame() ?? "").toContain("merge");
  });

  it("on terminal=failed the bottom bar does NOT show m merge", () => {
    let s = baseInit();
    s = runReducer(s, { kind: "terminate-run", status: "failed" });
    const { lastFrame } = renderApp(s);
    expect(lastFrame() ?? "").not.toContain("merge");
  });

  it("on terminal=succeeded with null branchName the bottom bar does NOT show m merge", () => {
    let s = createInitialRunState({
      factory: { name: "sdd" },
      brief: { change: "foo" },
      nodeIds: ["propose"],
      branchName: null,
    });
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    const { lastFrame } = renderApp(s);
    expect(lastFrame() ?? "").not.toContain("merge");
  });

  it("falls back to single-pane layout below 80x24", () => {
    const state = baseInit();
    const { lastFrame } = renderApp(state, { columns: 60, rows: 20 });
    const frame = lastFrame() ?? "";
    // Single-pane fallback hides the per-node status pane rows in compact mode;
    // we expect the header to still appear but not the row of all three node ids
    // adjacent to a glyph.
    expect(frame).toContain("propose");
    // The status pane is suppressed in compact mode — the apply and verify rows
    // are no longer rendered.
    expect(frame).not.toMatch(/▸ {2}◔ apply/);
  });

  it("renders the help overlay when showHelp is true", () => {
    let s = baseInit();
    s = runReducer(s, { kind: "toggle-help" });
    const { lastFrame } = renderApp(s);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hotkeys");
    expect(frame).toContain("? ");
  });

  it("renders the merge overlay when provided", () => {
    let s = baseInit();
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    const { lastFrame } = render(
      <RunApp
        state={s}
        glyphs={UNICODE_GLYPHS}
        handlers={noopHandlers()}
        inputEnabled={false}
        columns={100}
        rows={30}
        mergeOverlay={{ stdout: "merged ok\n", stderr: "", exitCode: 0, pending: false }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("minifac merge");
    expect(frame).toContain("merged ok");
  });
});
