import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "../storage/sqlite.js";
import {
  HUMAN_ANSWER_HEADING,
  ResumeStateError,
  humanAnswerBlock,
  resumeStateFromStore,
} from "./resume.js";

const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("resumeStateFromStore", () => {
  let dir: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-resume-state-"));
    store = SqliteRunStore.open(path.join(dir, "runs.db"));
  });

  afterEach(async () => {
    await store.close();
  });

  async function seed(): Promise<{ planResultPath: string }> {
    await store.createRun({
      id: RUN_ID,
      factoryPath: "/repo/.minifac/factories/scarif.yaml",
      factoryName: "scarif",
      change: "some-change",
      baseBranch: "main",
      worktreePath: path.join(dir, "worktree"),
      branchName: "minifac/scarif-abc123",
      startedAt: 1_000,
    });

    const planResultPath = path.join(dir, "plan-result.json");
    await writeFile(planResultPath, '{"approach":"x"}', "utf8");

    // plan ran twice; the second dispatch is the one downstream saw.
    await store.recordNodeStart(RUN_ID, "plan", 1, 1_100);
    await store.recordNodeEnd(RUN_ID, "plan", 1, { status: "failed", at: 1_200 });
    await store.recordNodeStart(RUN_ID, "plan", 2, 1_300);
    await store.recordNodeOutputs(RUN_ID, "plan", 2, {
      result: { type: "value", path: planResultPath, size: 16, mtime: 1_350 },
    });
    await store.recordNodeEnd(RUN_ID, "plan", 2, {
      status: "succeeded",
      sessionId: "sess-plan",
      at: 1_400,
    });

    // evaluate escalated.
    await store.recordNodeStart(RUN_ID, "evaluate", 1, 1_500);
    await store.appendEvent(RUN_ID, {
      nodeId: "evaluate",
      iteration: 1,
      kind: "status",
      payload: {
        kind: "status",
        status: "failed",
        meta: { reason: "sentinel_failed", sentinel: "escalate: AC-13 cannot be proved pre-merge" },
      },
      emittedAt: 500,
    });
    await store.recordNodeEnd(RUN_ID, "evaluate", 1, { status: "failed", at: 1_600 });

    // A node that was skipped on a budget hit: real history, but not a result.
    await store.recordNodeEnd(RUN_ID, "verify", 1, { status: "skipped", at: 1_650 });

    await store.finalizeRun(RUN_ID, {
      status: "failed",
      reason: "node_failed",
      proximateNodeId: "evaluate",
      endedAt: 1_700,
    });
    return { planResultPath };
  }

  it("rebuilds the NodeResult shape, latest ended iteration per node", async () => {
    const { planResultPath } = await seed();

    const state = await resumeStateFromStore({ store, runId: RUN_ID, at: "evaluate" });

    expect(state.at).toBe("evaluate");
    const byNode = Object.fromEntries(state.priorResults.map((r) => [r.nodeId, r]));
    expect(Object.keys(byNode).sort()).toEqual(["evaluate", "plan"]);
    expect(byNode.plan).toMatchObject({
      nodeId: "plan",
      iteration: 2,
      status: "succeeded",
      reason: null,
      session_id: "sess-plan",
      // Timestamps are rebased onto ms-since-run-start.
      startedAt: 300,
      endedAt: 400,
      outputs: { result: { type: "value", path: planResultPath, size: 16, mtime: 1_350 } },
    });
    expect(byNode.evaluate).toMatchObject({
      nodeId: "evaluate",
      iteration: 1,
      status: "failed",
      reason: "escalate: AC-13 cannot be proved pre-merge",
      outputs: null,
    });
  });

  it("carries per-node iteration counts, including a skipped node's", async () => {
    await seed();

    const state = await resumeStateFromStore({ store, runId: RUN_ID, at: "evaluate" });

    expect(state.iterations).toEqual({ plan: 2, evaluate: 1, verify: 1 });
  });

  it("carries the feedback when one is supplied and omits the key when it is not", async () => {
    await seed();

    const withAnswer = await resumeStateFromStore({
      store,
      runId: RUN_ID,
      at: "evaluate",
      feedback: "waive AC-13",
    });
    expect(withAnswer.feedback).toBe("waive AC-13");

    const without = await resumeStateFromStore({ store, runId: RUN_ID, at: "evaluate" });
    expect("feedback" in without).toBe(false);
  });

  it("refuses an unknown run id with a sentence naming it", async () => {
    await expect(
      resumeStateFromStore({ store, runId: "deadbeef", at: "evaluate" }),
    ).rejects.toThrow(ResumeStateError);
    await expect(
      resumeStateFromStore({ store, runId: "deadbeef", at: "evaluate" }),
    ).rejects.toThrow(/deadbeef/);
  });

  it("refuses a store that cannot read node executions", async () => {
    await seed();
    const crippled = {
      getRun: store.getRun.bind(store),
      getNodeOutputs: store.getNodeOutputs.bind(store),
      getRunEvents: store.getRunEvents.bind(store),
    };
    await expect(
      resumeStateFromStore({ store: crippled, runId: RUN_ID, at: "evaluate" }),
    ).rejects.toThrow(/cannot read node executions/);
  });
});

describe("reopenRun", () => {
  let dir: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-reopen-"));
    store = SqliteRunStore.open(path.join(dir, "runs.db"));
  });

  afterEach(async () => {
    await store.close();
  });

  it("puts a finished run back to running and clears its termination", async () => {
    await store.createRun({
      id: RUN_ID,
      factoryPath: "/f.yaml",
      factoryName: "f",
      startedAt: 1,
    });
    await store.finalizeRun(RUN_ID, {
      status: "failed",
      reason: "node_failed",
      proximateNodeId: "evaluate",
      endedAt: 9,
    });

    await store.reopenRun(RUN_ID);

    const row = await store.getRun(RUN_ID);
    expect(row).toMatchObject({
      status: "running",
      reason: null,
      proximateNodeId: null,
      endedAt: null,
    });
  });

  it("is a no-op for an unknown run id", async () => {
    await expect(store.reopenRun("no-such-run")).resolves.toBeUndefined();
  });
});

describe("humanAnswerBlock", () => {
  it("fences the answer so a heading inside it cannot be read as the prompt's", () => {
    const block = humanAnswerBlock("## Not a section\nwaive it");
    expect(block.startsWith(HUMAN_ANSWER_HEADING)).toBe(true);
    expect(block).toContain("-----BEGIN HUMAN ANSWER-----");
    expect(block).toContain("## Not a section\nwaive it");
    expect(block).toContain("-----END HUMAN ANSWER-----");
  });
});
