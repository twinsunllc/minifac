import { describe, expect, it } from "vitest";
import type { EmittedEvent } from "../executor/types.js";
import { createInitialRunState, isMergeAvailable, runReducer, visibleEvents } from "./reducer.js";

const init = () =>
  createInitialRunState({
    factory: { name: "sdd" },
    brief: { change: "foo" },
    nodeIds: ["propose", "apply", "verify"],
    branchName: "minifac/run/foo/abc",
  });

const stdoutEvent = (nodeId: string, iteration: number, line: string): EmittedEvent => ({
  nodeId,
  iteration,
  emittedAt: 0,
  event: { kind: "stdout", line },
});

const statusEvent = (
  nodeId: string,
  iteration: number,
  status: "started" | "succeeded" | "failed",
): EmittedEvent => ({
  nodeId,
  iteration,
  emittedAt: 0,
  event: { kind: "status", status },
});

describe("runReducer", () => {
  it("first stdout for a pending node moves it to running and creates iteration 1", () => {
    const s0 = init();
    const s1 = runReducer(s0, stdoutEvent("propose", 1, '{"type":"system","subtype":"init"}'));
    const propose = s1.nodes.find((n) => n.id === "propose");
    expect(propose?.status).toBe("running");
    expect(propose?.iteration).toBe(1);
    expect(propose?.iterations.length).toBe(1);
  });

  it("status=succeeded sets node status and iteration terminalStatus", () => {
    let s = init();
    s = runReducer(
      s,
      stdoutEvent(
        "propose",
        1,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
      ),
    );
    s = runReducer(s, statusEvent("propose", 1, "succeeded"));
    const propose = s.nodes.find((n) => n.id === "propose");
    expect(propose?.status).toBe("succeeded");
    expect(propose?.iterations[0]?.terminalStatus).toBe("succeeded");
  });

  it("a status=failed then a new stdout starts iteration 2", () => {
    let s = init();
    s = runReducer(
      s,
      stdoutEvent(
        "verify",
        1,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}',
      ),
    );
    s = runReducer(s, statusEvent("verify", 1, "failed"));
    let verify = s.nodes.find((n) => n.id === "verify");
    expect(verify?.status).toBe("failed");
    expect(verify?.iterations[0]?.terminalStatus).toBe("failed");

    s = runReducer(
      s,
      stdoutEvent(
        "verify",
        2,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"y"}]}}',
      ),
    );
    verify = s.nodes.find((n) => n.id === "verify");
    expect(verify?.status).toBe("running");
    expect(verify?.iteration).toBe(2);
    expect(verify?.iterations.length).toBe(2);
    expect(verify?.iterations[0]?.terminalStatus).toBe("failed");
  });

  it("navigate-down pauses follow mode and advances selection", () => {
    let s = init();
    expect(s.followMode).toBe(true);
    s = runReducer(s, { kind: "navigate-down" });
    expect(s.followMode).toBe(false);
    expect(s.selectedNodeId).toBe("apply");
  });

  it("navigate-up pauses follow mode and moves back", () => {
    let s = init();
    s = { ...s, selectedNodeId: "apply" };
    s = runReducer(s, { kind: "navigate-up" });
    expect(s.followMode).toBe(false);
    expect(s.selectedNodeId).toBe("propose");
  });

  it("enter-follow flips followMode true and jumps to running node", () => {
    let s = init();
    s = runReducer(
      s,
      stdoutEvent(
        "apply",
        1,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}',
      ),
    );
    s = runReducer(s, { kind: "navigate-up" });
    expect(s.followMode).toBe(false);
    s = runReducer(s, { kind: "enter-follow" });
    expect(s.followMode).toBe(true);
    expect(s.selectedNodeId).toBe("apply");
  });

  it("cycle-iteration-prev/next walk iterations bounded by node.iteration", () => {
    let s = init();
    s = runReducer(s, stdoutEvent("verify", 1, '{"x":1}'));
    s = runReducer(s, statusEvent("verify", 1, "failed"));
    s = runReducer(s, stdoutEvent("verify", 2, '{"x":2}'));
    expect(s.selectedIteration).toBe(2);
    s = runReducer(s, { kind: "cycle-iteration-prev" });
    expect(s.selectedIteration).toBe(1);
    s = runReducer(s, { kind: "cycle-iteration-prev" });
    expect(s.selectedIteration).toBe(1);
    s = runReducer(s, { kind: "cycle-iteration-next" });
    expect(s.selectedIteration).toBe(2);
    s = runReducer(s, { kind: "cycle-iteration-next" });
    expect(s.selectedIteration).toBe(2);
  });

  it("scroll-log-up clamps to zero; scroll-log-down advances", () => {
    let s = init();
    s = runReducer(s, { kind: "scroll-log-up" });
    expect(s.scrollOffset).toBe(0);
    s = runReducer(s, { kind: "scroll-log-down" });
    expect(s.scrollOffset).toBe(5);
    s = runReducer(s, { kind: "scroll-log-up" });
    expect(s.scrollOffset).toBe(0);
  });

  it("toggle-details flips entry in detailsOpen", () => {
    let s = init();
    s = runReducer(s, stdoutEvent("propose", 1, '{"type":"assistant"}'));
    s = runReducer(s, { kind: "toggle-details" });
    expect(s.detailsOpen.has("propose|1|0")).toBe(true);
    s = runReducer(s, { kind: "toggle-details" });
    expect(s.detailsOpen.has("propose|1|0")).toBe(false);
  });

  it("request-quit mid-run shows quit prompt; cancel-quit clears it", () => {
    let s = init();
    s = runReducer(s, { kind: "request-quit" });
    expect(s.showQuitPrompt).toBe(true);
    s = runReducer(s, { kind: "cancel-quit" });
    expect(s.showQuitPrompt).toBe(false);
  });

  it("request-quit on terminal-status state does not raise prompt", () => {
    let s = init();
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    s = runReducer(s, { kind: "request-quit" });
    expect(s.showQuitPrompt).toBe(false);
  });

  it("confirm-quit clears the prompt", () => {
    let s = init();
    s = runReducer(s, { kind: "request-quit" });
    s = runReducer(s, { kind: "confirm-quit" });
    expect(s.showQuitPrompt).toBe(false);
  });

  it("toggle-help flips the help overlay", () => {
    let s = init();
    s = runReducer(s, { kind: "toggle-help" });
    expect(s.showHelp).toBe(true);
    s = runReducer(s, { kind: "toggle-help" });
    expect(s.showHelp).toBe(false);
  });

  it("terminate-run sets terminalStatus and node statuses are unchanged", () => {
    let s = init();
    s = runReducer(s, stdoutEvent("propose", 1, '{"x":1}'));
    s = runReducer(s, statusEvent("propose", 1, "succeeded"));
    const proposeBefore = s.nodes.find((n) => n.id === "propose");
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    expect(s.terminalStatus).toBe("succeeded");
    const proposeAfter = s.nodes.find((n) => n.id === "propose");
    expect(proposeAfter?.status).toBe(proposeBefore?.status);
  });

  it("isMergeAvailable requires succeeded + branchName", () => {
    let s = init();
    expect(isMergeAvailable(s)).toBe(false);
    s = runReducer(s, { kind: "terminate-run", status: "succeeded" });
    expect(isMergeAvailable(s)).toBe(true);
    s = { ...s, branchName: null };
    expect(isMergeAvailable(s)).toBe(false);
  });

  it("visibleEvents hides suppressed system_init lines", () => {
    let s = init();
    s = runReducer(s, stdoutEvent("propose", 1, '{"type":"system","subtype":"init"}'));
    const visible = visibleEvents(s);
    expect(visible.events.length).toBe(0);
  });

  it("follow mode keeps selection on the currently-running node", () => {
    let s = init();
    s = runReducer(s, stdoutEvent("apply", 1, '{"x":1}'));
    expect(s.selectedNodeId).toBe("apply");
  });

  it("tick increments the tick counter", () => {
    let s = init();
    s = runReducer(s, { kind: "tick" });
    expect(s.tick).toBe(1);
    s = runReducer(s, { kind: "tick" });
    expect(s.tick).toBe(2);
  });
});
