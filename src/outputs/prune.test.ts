import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteRunStore } from "../storage/sqlite.js";
import { pruneOutputs } from "./prune.js";

async function tmp(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

describe("pruneOutputs", () => {
  let workDir: string;
  let outputsRoot: string;
  let store: SqliteRunStore;

  beforeEach(async () => {
    workDir = await tmp("minifac-prune-out-");
    outputsRoot = path.join(workDir, "outputs");
    await mkdir(outputsRoot, { recursive: true });
    store = SqliteRunStore.open(path.join(workDir, "runs.db"));
  });
  afterEach(async () => {
    await store.close();
  });

  async function seedRun(
    id: string,
    status: "running" | "succeeded" | "failed",
    mtime: number,
  ): Promise<string> {
    const dir = path.join(outputsRoot, id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "x.txt"), "hello");
    await store.createRun({
      id,
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      startedAt: 0,
    });
    if (status !== "running") {
      await store.finalizeRun(id, { status, reason: null, endedAt: 1 });
    }
    await store.recordNodeOutputs(id, "n", 1, {
      x: { type: "value", path: path.join(dir, "x.txt"), size: 5, mtime: 1 },
    });
    // Force-set the mtime by writing a file with a known mtime.
    const fs = await import("node:fs/promises");
    await fs.utimes(dir, mtime / 1000, mtime / 1000);
    return dir;
  }

  it("removes only merged-old (succeeded) by default", async () => {
    const now = Date.now();
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const oneHour = 60 * 60 * 1000;
    await seedRun("ok-old", "succeeded", now - eightDays);
    await seedRun("ok-fresh", "succeeded", now - oneHour);
    await seedRun("fail-old", "failed", now - eightDays);
    const counts = await pruneOutputs({ options: {}, store, now, outputsRoot });
    expect(counts.removed["merged-old"]).toBe(1);
    expect(counts.removed.failed).toBe(0);
    expect(counts.removed.fresh).toBe(0);
    // node_outputs rows for ok-old should be gone.
    const okOldRows = await store.getNodeOutputs("ok-old");
    expect(okOldRows.length).toBe(0);
    // node_outputs rows for ok-fresh should remain.
    const okFreshRows = await store.getNodeOutputs("ok-fresh");
    expect(okFreshRows.length).toBe(1);
  });

  it("--outputs --all --failed removes everything terminated", async () => {
    const now = Date.now();
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    const oneHour = 60 * 60 * 1000;
    await seedRun("ok-old", "succeeded", now - eightDays);
    await seedRun("ok-fresh", "succeeded", now - oneHour);
    await seedRun("fail-old", "failed", now - eightDays);
    const counts = await pruneOutputs({
      options: { all: true, failed: true },
      store,
      now,
      outputsRoot,
    });
    expect(counts.removed["merged-old"]).toBe(1);
    expect(counts.removed.fresh).toBe(1);
    expect(counts.removed.failed).toBe(1);
  });

  it("running runs are never eligible", async () => {
    const now = Date.now();
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    await seedRun("running-old", "running", now - eightDays);
    const counts = await pruneOutputs({
      options: { all: true, failed: true },
      store,
      now,
      outputsRoot,
    });
    expect(counts.removed["merged-old"]).toBe(0);
    expect(counts.removed.fresh).toBe(0);
    expect(counts.removed.failed).toBe(0);
    // node_outputs rows preserved.
    const rows = await store.getNodeOutputs("running-old");
    expect(rows.length).toBe(1);
  });

  it("--older-than overrides the 7-day cutoff", async () => {
    const now = Date.now();
    const tenDays = 10 * 24 * 60 * 60 * 1000;
    await seedRun("ten-day-old-ok", "succeeded", now - tenDays);
    const counts = await pruneOutputs({
      options: { olderThan: { value: 30, unit: "d" } },
      store,
      now,
      outputsRoot,
    });
    // 10 days < 30 days → classified fresh → not removed by default.
    expect(counts.removed["merged-old"]).toBe(0);
    expect(counts.kept.fresh).toBe(1);
  });
});
