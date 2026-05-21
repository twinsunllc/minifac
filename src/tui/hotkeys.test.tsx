import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { HotkeyInput } from "./hotkeys.js";
import {
  type RunState,
  type UIEvent,
  createInitialRunState,
  isMergeAvailable,
  runReducer,
} from "./reducer.js";

const init = (overrides: Partial<RunState> = {}) => ({
  ...createInitialRunState({
    factory: { name: "sdd" },
    brief: { change: "foo" },
    nodeIds: ["propose", "apply", "verify"],
    branchName: "minifac/run/foo/abc",
  }),
  ...overrides,
});

interface Harness {
  dispatched: UIEvent[];
  onRawSwitch: ReturnType<typeof vi.fn>;
  onQuit: ReturnType<typeof vi.fn>;
  onMerge: ReturnType<typeof vi.fn>;
}

function setup(state: RunState): {
  rerender: (s: RunState) => void;
  send: (input: string) => void;
  harness: Harness;
} {
  const dispatched: UIEvent[] = [];
  const onRawSwitch = vi.fn();
  const onQuit = vi.fn();
  const onMerge = vi.fn();
  const handlers = {
    dispatch: (event: UIEvent) => {
      dispatched.push(event);
    },
    onRawSwitch,
    onQuit,
    onMerge,
  };
  const tree = (s: RunState): ReactElement => <HotkeyInput state={s} handlers={handlers} />;
  const instance = render(tree(state));
  return {
    rerender: (s) => instance.rerender(tree(s)),
    send: (input) => {
      instance.stdin.write(input);
    },
    harness: { dispatched, onRawSwitch, onQuit, onMerge },
  };
}

describe("HotkeyInput", () => {
  it("j moves selection down and unsets follow mode", () => {
    const { send, harness } = setup(init());
    send("j");
    expect(harness.dispatched).toEqual([{ kind: "navigate-down" }]);
  });

  it("k moves selection up and unsets follow mode", () => {
    const { send, harness } = setup(init({ selectedNodeId: "apply" }));
    send("k");
    expect(harness.dispatched).toEqual([{ kind: "navigate-up" }]);
  });

  it("Enter sets followMode=true and selects the running node (dispatch)", () => {
    const { send, harness } = setup(init());
    send("\r");
    expect(harness.dispatched).toEqual([{ kind: "enter-follow" }]);
  });

  it("< and > dispatch cycle-iteration", () => {
    const { send, harness } = setup(init());
    send("<");
    send(">");
    expect(harness.dispatched).toEqual([
      { kind: "cycle-iteration-prev" },
      { kind: "cycle-iteration-next" },
    ]);
  });

  it("d dispatches toggle-details", () => {
    const { send, harness } = setup(init());
    send("d");
    expect(harness.dispatched).toEqual([{ kind: "toggle-details" }]);
  });

  it("r triggers onRawSwitch (renderer side)", () => {
    const { send, harness } = setup(init());
    send("r");
    expect(harness.onRawSwitch).toHaveBeenCalled();
  });

  it("q mid-run dispatches request-quit (not onQuit yet)", () => {
    const { send, harness } = setup(init());
    send("q");
    expect(harness.dispatched).toEqual([{ kind: "request-quit" }]);
    expect(harness.onQuit).not.toHaveBeenCalled();
  });

  it("q on a terminal-status run triggers immediate onQuit", () => {
    let s = init();
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    const { send, harness } = setup(s);
    send("q");
    expect(harness.onQuit).toHaveBeenCalled();
  });

  it("y at the quit prompt dispatches confirm-quit and triggers onQuit", () => {
    let s = init();
    s = runReducer(s, { kind: "request-quit" });
    expect(s.showQuitPrompt).toBe(true);
    const { send, harness } = setup(s);
    send("y");
    expect(harness.dispatched).toContainEqual({ kind: "confirm-quit" });
    expect(harness.onQuit).toHaveBeenCalled();
  });

  it("n at the quit prompt dispatches cancel-quit", () => {
    let s = init();
    s = runReducer(s, { kind: "request-quit" });
    const { send, harness } = setup(s);
    send("n");
    expect(harness.dispatched).toContainEqual({ kind: "cancel-quit" });
    expect(harness.onQuit).not.toHaveBeenCalled();
  });

  it("m on succeeded + branchName triggers onMerge", () => {
    let s = init();
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    expect(isMergeAvailable(s)).toBe(true);
    const { send, harness } = setup(s);
    send("m");
    expect(harness.onMerge).toHaveBeenCalled();
  });

  it("m on succeeded with null branchName is a no-op", () => {
    let s = init({ branchName: null });
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    expect(isMergeAvailable(s)).toBe(false);
    const { send, harness } = setup(s);
    send("m");
    expect(harness.onMerge).not.toHaveBeenCalled();
  });

  it("m on a failed run is a no-op", () => {
    let s = init();
    s = runReducer(s, { kind: "terminate-run", status: "failed" });
    const { send, harness } = setup(s);
    send("m");
    expect(harness.onMerge).not.toHaveBeenCalled();
  });

  it("? toggles the help overlay", () => {
    const { send, harness } = setup(init());
    send("?");
    expect(harness.dispatched).toEqual([{ kind: "toggle-help" }]);
  });
});
