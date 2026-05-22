import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { type AutorunHandlers, AutorunHotkeyInput } from "./autorun-app.js";
import {
  type AutorunUIEvent,
  type BriefListState,
  autorunReducer,
  createInitialBriefListState,
  makeRunStateSlot,
} from "./autorun-reducer.js";
import type { ReducerEvent, UIEvent } from "./reducer.js";

interface Harness {
  autorun: AutorunUIEvent[];
  run: ReducerEvent[];
  onRawSwitch: ReturnType<typeof vi.fn>;
  onQuit: ReturnType<typeof vi.fn>;
}

function setup(
  state: BriefListState,
  inFlight = 0,
): {
  rerender: (s: BriefListState, inFlight?: number) => void;
  send: (input: string) => void;
  harness: Harness;
} {
  const autorun: AutorunUIEvent[] = [];
  const run: ReducerEvent[] = [];
  const onRawSwitch = vi.fn();
  const onQuit = vi.fn();
  const handlers: AutorunHandlers = {
    dispatchAutorun: (e) => autorun.push(e),
    dispatchRun: (e) => run.push(e as UIEvent),
    onRawSwitch,
    onQuit,
  };
  const tree = (s: BriefListState, n: number): ReactElement => (
    <AutorunHotkeyInput state={s} handlers={handlers} inFlight={n} />
  );
  const instance = render(tree(state, inFlight));
  return {
    rerender: (s, n) => instance.rerender(tree(s, n ?? 0)),
    send: (input) => {
      instance.stdin.write(input);
    },
    harness: { autorun, run, onRawSwitch, onQuit },
  };
}

function withTwoBriefs(): BriefListState {
  let s = createInitialBriefListState({ watchBasename: "inputs", maxConcurrent: 2 });
  s = autorunReducer(s, { kind: "started", ts: 0, change: "foo" });
  s = autorunReducer(s, { kind: "started", ts: 1, change: "bar" });
  return s;
}

function withSlot(change = "foo"): BriefListState {
  let s = withTwoBriefs();
  const slot = makeRunStateSlot({
    factory: { name: "sdd" },
    brief: { change },
    nodeIds: ["only"],
  });
  s = autorunReducer(s, { kind: "set-run-state", change, runState: slot });
  return s;
}

describe("AutorunHotkeyInput — brief-list focus", () => {
  it("j and ↓ move selection down without changing focus", () => {
    const { send, harness } = setup(withTwoBriefs());
    send("j");
    expect(harness.autorun.at(-1)).toEqual({ kind: "select-brief-next" });
  });
  it("k moves selection up", () => {
    const { send, harness } = setup(withTwoBriefs());
    send("k");
    expect(harness.autorun.at(-1)).toEqual({ kind: "select-brief-prev" });
  });
  it("Enter on a brief with a populated RunState slot dispatches enter-brief", () => {
    const { send, harness } = setup(withSlot("foo"));
    send("\r");
    expect(harness.autorun.at(-1)).toEqual({ kind: "enter-brief" });
  });
  it("Enter on a brief without a slot still dispatches enter-brief (reducer no-ops)", () => {
    const { send, harness } = setup(withTwoBriefs());
    send("\r");
    // The component emits the event; the reducer is what no-ops.
    expect(harness.autorun.at(-1)).toEqual({ kind: "enter-brief" });
  });
  it("? toggles the help overlay", () => {
    const { send, harness } = setup(withTwoBriefs());
    send("?");
    expect(harness.autorun.at(-1)).toEqual({ kind: "toggle-help" });
  });
  it("r triggers onRawSwitch", () => {
    const { send, harness } = setup(withTwoBriefs());
    send("r");
    expect(harness.onRawSwitch).toHaveBeenCalled();
  });
  it("q with no in-flight runs triggers onQuit immediately", () => {
    const { send, harness } = setup(withTwoBriefs(), 0);
    send("q");
    expect(harness.onQuit).toHaveBeenCalled();
  });
  it("q with in-flight runs first dispatches request-quit and then onQuit (drain initiated)", () => {
    const { send, harness } = setup(withTwoBriefs(), 1);
    send("q");
    expect(harness.autorun.some((e) => e.kind === "request-quit")).toBe(true);
    expect(harness.onQuit).toHaveBeenCalled();
  });
});

describe("AutorunHotkeyInput — run-view focus", () => {
  function focused(): BriefListState {
    let s = withSlot("foo");
    s = autorunReducer(s, { kind: "enter-brief" });
    return s;
  }

  it("Esc returns to the brief list", async () => {
    const { send, harness } = setup(focused());
    send("\u001b"); // Esc
    await new Promise((r) => setTimeout(r, 30));
    expect(harness.autorun.some((e) => e.kind === "back-to-list")).toBe(true);
  });
  it("j / k navigate within the run view (dispatchRun)", () => {
    const { send, harness } = setup(focused());
    send("j");
    expect(harness.run.at(-1)).toEqual({ kind: "navigate-down" });
    send("k");
    expect(harness.run.at(-1)).toEqual({ kind: "navigate-up" });
  });
  it("Enter inside the run view dispatches enter-follow", () => {
    const { send, harness } = setup(focused());
    send("\r");
    expect(harness.run.at(-1)).toEqual({ kind: "enter-follow" });
  });
  it("< and > cycle iterations", () => {
    const { send, harness } = setup(focused());
    send("<");
    send(">");
    expect(harness.run.slice(-2)).toEqual([
      { kind: "cycle-iteration-prev" },
      { kind: "cycle-iteration-next" },
    ]);
  });
  it("d toggles details in the run view", () => {
    const { send, harness } = setup(focused());
    send("d");
    expect(harness.run.at(-1)).toEqual({ kind: "toggle-details" });
  });
  it("r and q at the autorun level still apply (process-level)", () => {
    const { send, harness } = setup(focused());
    send("r");
    expect(harness.onRawSwitch).toHaveBeenCalled();
    send("q");
    expect(harness.onQuit).toHaveBeenCalled();
  });
});
