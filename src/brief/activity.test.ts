import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteRunStore } from "../storage/sqlite.js";
import { computeBriefActivity } from "./activity.js";

async function freshStore(): Promise<SqliteRunStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-activity-"));
  return SqliteRunStore.open(path.join(dir, "runs.db"));
}

describe("computeBriefActivity", () => {
  it("returns none when no rows match the change", async () => {
    const store = await freshStore();
    try {
      const r = await computeBriefActivity("foo", { runStore: store });
      expect(r.activity).toBe("none");
      expect(r.mostRecentRunId).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("returns running when the most recent row is running", async () => {
    const store = await freshStore();
    try {
      await store.createRun({
        id: "run-1",
        factoryPath: "/p",
        factoryName: "sdd",
        change: "foo",
        branchName: "run/foo-aaa",
        startedAt: 100,
      });
      const r = await computeBriefActivity("foo", { runStore: store });
      expect(r.activity).toBe("running");
      expect(r.mostRecentRunId).toBe("run-1");
      expect(r.branchName).toBe("run/foo-aaa");
    } finally {
      await store.close();
    }
  });

  it("returns succeeded when the most recent row is succeeded", async () => {
    const store = await freshStore();
    try {
      await store.createRun({
        id: "run-s",
        factoryPath: "/p",
        factoryName: "sdd",
        change: "foo",
        startedAt: 100,
      });
      await store.finalizeRun("run-s", { status: "succeeded", endedAt: 200 });
      const r = await computeBriefActivity("foo", { runStore: store });
      expect(r.activity).toBe("succeeded");
      expect(r.mostRecentRunId).toBe("run-s");
      expect(r.endedAt).toBe(200);
    } finally {
      await store.close();
    }
  });

  it("returns failed when the most recent row is failed", async () => {
    const store = await freshStore();
    try {
      await store.createRun({
        id: "run-f",
        factoryPath: "/p",
        factoryName: "sdd",
        change: "foo",
        startedAt: 100,
      });
      await store.finalizeRun("run-f", { status: "failed", endedAt: 200 });
      const r = await computeBriefActivity("foo", { runStore: store });
      expect(r.activity).toBe("failed");
      expect(r.mostRecentRunId).toBe("run-f");
    } finally {
      await store.close();
    }
  });

  it("returns the most recent row when multiple exist", async () => {
    const store = await freshStore();
    try {
      await store.createRun({
        id: "older",
        factoryPath: "/p",
        factoryName: "sdd",
        change: "foo",
        startedAt: 100,
      });
      await store.finalizeRun("older", { status: "failed", endedAt: 150 });
      await store.createRun({
        id: "newer",
        factoryPath: "/p",
        factoryName: "sdd",
        change: "foo",
        startedAt: 300,
      });
      await store.finalizeRun("newer", { status: "succeeded", endedAt: 400 });
      const r = await computeBriefActivity("foo", { runStore: store });
      expect(r.activity).toBe("succeeded");
      expect(r.mostRecentRunId).toBe("newer");
    } finally {
      await store.close();
    }
  });
});
