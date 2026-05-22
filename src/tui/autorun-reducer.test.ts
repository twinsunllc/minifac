import { describe, expect, it } from "vitest";
import type { AutorunEvent } from "../cli/autorun.js";
import {
  autorunReducer,
  createInitialBriefListState,
  makeRunStateSlot,
} from "./autorun-reducer.js";

function ev<T extends AutorunEvent>(e: T): T {
  return e;
}

describe("autorunReducer", () => {
  it("seeds an empty brief list at startup", () => {
    const s = createInitialBriefListState({ watchBasename: "inputs", maxConcurrent: 2 });
    expect(s.briefs).toHaveLength(0);
    expect(s.focus).toBe("brief-list");
    expect(s.watchBasename).toBe("inputs");
    expect(s.maxConcurrent).toBe(2);
  });

  it("started event adds a brief with status=running", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo", runId: "r1" }));
    expect(s.briefs).toEqual([{ change: "foo", status: "running", runId: "r1" }]);
  });

  it("subsequent started events for unseen briefs append in arrival order", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    s = autorunReducer(s, ev({ kind: "started", ts: 1, change: "bar" }));
    expect(s.briefs.map((b) => b.change)).toEqual(["foo", "bar"]);
  });

  it("poll-start is a no-op for the brief list", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "poll-start", ts: 0, briefs: 3 }));
    expect(s.briefs).toHaveLength(0);
  });

  it("startup and info events are no-ops for the brief list", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "startup", ts: 0, options: { watch: "inputs" } }));
    s = autorunReducer(s, ev({ kind: "info", ts: 1, message: "noop" }));
    expect(s.briefs).toHaveLength(0);
  });

  it("completed status=succeeded marks the brief succeeded", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    s = autorunReducer(
      s,
      ev({ kind: "completed", ts: 1, change: "foo", status: "succeeded", runId: "r1" }),
    );
    expect(s.briefs[0]?.status).toBe("succeeded");
    expect(s.briefs[0]?.runId).toBe("r1");
  });

  it("completed status=failed marks the brief failed", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    s = autorunReducer(s, ev({ kind: "completed", ts: 1, change: "foo", status: "failed" }));
    expect(s.briefs[0]?.status).toBe("failed");
  });

  it("skipped event records skipped status and reason", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "skipped", ts: 0, change: "foo", reason: "blocked" }));
    expect(s.briefs[0]?.status).toBe("skipped");
    expect(s.briefs[0]?.skipReason).toBe("blocked");
  });

  it("skipped brief transitions back to running on a later started", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "skipped", ts: 0, change: "foo", reason: "blocked" }));
    s = autorunReducer(s, ev({ kind: "started", ts: 1, change: "foo" }));
    expect(s.briefs[0]?.status).toBe("running");
    expect(s.briefs[0]?.skipReason).toBeUndefined();
  });

  it("skipped → started → completed (succeeded) ends with no residual skipReason", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(
      s,
      ev({ kind: "skipped", ts: 0, change: "foo", reason: "activity-succeeded" }),
    );
    s = autorunReducer(s, ev({ kind: "started", ts: 1, change: "foo", runId: "r1" }));
    s = autorunReducer(
      s,
      ev({ kind: "completed", ts: 2, change: "foo", status: "succeeded", runId: "r1" }),
    );
    expect(s.briefs[0]?.status).toBe("succeeded");
    expect(s.briefs[0]?.skipReason).toBeUndefined();
    expect(s.briefs[0]?.runId).toBe("r1");
  });

  it("skipped → started → completed (failed) ends with no residual skipReason", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(
      s,
      ev({ kind: "skipped", ts: 0, change: "foo", reason: "activity-running" }),
    );
    s = autorunReducer(s, ev({ kind: "started", ts: 1, change: "foo", runId: "r2" }));
    s = autorunReducer(s, ev({ kind: "completed", ts: 2, change: "foo", status: "failed" }));
    expect(s.briefs[0]?.status).toBe("failed");
    expect(s.briefs[0]?.skipReason).toBeUndefined();
    expect(s.briefs[0]?.runId).toBe("r2");
  });

  it("started → skipped(in-flight) leaves the row running with no skipReason", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo", runId: "r1" }));
    s = autorunReducer(
      s,
      ev({ kind: "skipped", ts: 1, change: "foo", reason: "activity-running" }),
    );
    expect(s.briefs[0]?.status).toBe("running");
    expect(s.briefs[0]?.skipReason).toBeUndefined();
    expect(s.briefs[0]?.runId).toBe("r1");
  });

  it("started → completed(succeeded) → skipped(activity-succeeded) preserves succeeded", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo", runId: "r1" }));
    s = autorunReducer(
      s,
      ev({ kind: "completed", ts: 1, change: "foo", status: "succeeded", runId: "r1" }),
    );
    s = autorunReducer(
      s,
      ev({ kind: "skipped", ts: 2, change: "foo", reason: "activity-succeeded" }),
    );
    expect(s.briefs[0]?.status).toBe("succeeded");
    expect(s.briefs[0]?.skipReason).toBeUndefined();
  });

  it("started → completed(failed) → skipped(activity-failed) preserves failed", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo", runId: "r2" }));
    s = autorunReducer(s, ev({ kind: "completed", ts: 1, change: "foo", status: "failed" }));
    s = autorunReducer(s, ev({ kind: "skipped", ts: 2, change: "foo", reason: "activity-failed" }));
    expect(s.briefs[0]?.status).toBe("failed");
    expect(s.briefs[0]?.skipReason).toBeUndefined();
  });

  it("queued → skipped overwrites with skipped + reason", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(
      s,
      ev({ kind: "dry-run-decision", ts: 0, change: "foo", action: "schedule" }),
    );
    expect(s.briefs[0]?.status).toBe("queued");
    s = autorunReducer(s, ev({ kind: "skipped", ts: 1, change: "foo", reason: "blocked" }));
    expect(s.briefs[0]?.status).toBe("skipped");
    expect(s.briefs[0]?.skipReason).toBe("blocked");
  });

  it("skipped → skipped(new reason) updates the reason", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "skipped", ts: 0, change: "foo", reason: "old-reason" }));
    s = autorunReducer(s, ev({ kind: "skipped", ts: 1, change: "foo", reason: "new-reason" }));
    expect(s.briefs[0]?.status).toBe("skipped");
    expect(s.briefs[0]?.skipReason).toBe("new-reason");
  });

  it("dry-run-decision action=schedule routes to queued", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(
      s,
      ev({ kind: "dry-run-decision", ts: 0, change: "foo", action: "schedule" }),
    );
    expect(s.briefs[0]?.status).toBe("queued");
  });

  it("dry-run-decision action=skip routes to skipped with reason", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(
      s,
      ev({
        kind: "dry-run-decision",
        ts: 0,
        change: "bar",
        action: "skip",
        reason: "blocked",
        detail: "deps not met",
      }),
    );
    expect(s.briefs[0]?.status).toBe("skipped");
    expect(s.briefs[0]?.skipReason).toBe("blocked");
  });

  it("select-brief-next moves selection", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    s = autorunReducer(s, ev({ kind: "started", ts: 1, change: "bar" }));
    s = autorunReducer(s, { kind: "select-brief-next" });
    expect(s.selectedBriefIndex).toBe(1);
    expect(s.focus).toBe("brief-list");
  });

  it("select-brief-next clamps at the bottom", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    s = autorunReducer(s, { kind: "select-brief-next" });
    expect(s.selectedBriefIndex).toBe(0);
  });

  it("select-brief-prev clamps at the top (no wrap)", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    s = autorunReducer(s, { kind: "select-brief-prev" });
    expect(s.selectedBriefIndex).toBe(0);
  });

  it("enter-brief is a no-op when the selected brief has no RunState slot", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    s = autorunReducer(s, { kind: "enter-brief" });
    expect(s.focus).toBe("brief-list");
  });

  it("enter-brief drills into the embedded run view when RunState is populated", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    const runState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "foo" },
      nodeIds: ["a"],
    });
    s = autorunReducer(s, { kind: "set-run-state", change: "foo", runState });
    s = autorunReducer(s, { kind: "enter-brief" });
    expect(s.focus).toBe("run-view");
  });

  it("back-to-list returns focus to the brief list and preserves the run state slot", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    const runState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "foo" },
      nodeIds: ["a"],
    });
    s = autorunReducer(s, { kind: "set-run-state", change: "foo", runState });
    s = autorunReducer(s, { kind: "enter-brief" });
    s = autorunReducer(s, { kind: "back-to-list" });
    expect(s.focus).toBe("brief-list");
    expect(s.briefs[0]?.runState).toBeDefined();
  });

  it("request-quit flips quitConfirm; cancel-quit clears it", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, { kind: "request-quit" });
    expect(s.quitConfirm).toBe(true);
    s = autorunReducer(s, { kind: "cancel-quit" });
    expect(s.quitConfirm).toBe(false);
  });

  it("confirm-quit clears the prompt", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, { kind: "request-quit" });
    s = autorunReducer(s, { kind: "confirm-quit" });
    expect(s.quitConfirm).toBe(false);
  });

  it("toggle-help flips the help overlay", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, { kind: "toggle-help" });
    expect(s.showHelp).toBe(true);
    s = autorunReducer(s, { kind: "toggle-help" });
    expect(s.showHelp).toBe(false);
  });

  it("tick increments the tick counter", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, { kind: "tick" });
    expect(s.tick).toBe(1);
  });

  it("set-run-state writes the per-brief RunState slot without changing autorun status", () => {
    let s = createInitialBriefListState();
    s = autorunReducer(s, ev({ kind: "started", ts: 0, change: "foo" }));
    const runState = makeRunStateSlot({
      factory: { name: "sdd" },
      brief: { change: "foo" },
      nodeIds: ["a"],
    });
    s = autorunReducer(s, { kind: "set-run-state", change: "foo", runState });
    expect(s.briefs[0]?.runState).toBe(runState);
    expect(s.briefs[0]?.status).toBe("running");
  });
});
