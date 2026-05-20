import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...p: unknown[]): unknown;
      get(...p: unknown[]): unknown;
      all(...p: unknown[]): unknown[];
    };
    close(): void;
  };
};
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationVersionError, SqliteRunStore } from "./sqlite.js";

async function tmp(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

describe("SqliteRunStore", () => {
  let dir: string;
  let store: SqliteRunStore | undefined;

  beforeEach(async () => {
    dir = await tmp("minifac-runs-");
  });

  afterEach(async () => {
    if (store) {
      await store.close();
      store = undefined;
    }
  });

  it("creates the DB file lazily and applies the v1 schema", async () => {
    const dbPath = path.join(dir, "nested", "runs.db");
    store = SqliteRunStore.open(dbPath);
    // Verify by opening a parallel read-only handle.
    const inspector = new DatabaseSync(dbPath);
    try {
      const journal = inspector.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      expect(journal.journal_mode.toLowerCase()).toBe("wal");
      const ver = inspector
        .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version")
        .get() as { v: number };
      expect(ver.v).toBe(1);
      const tables = inspector
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("runs");
      expect(names).toContain("events");
      expect(names).toContain("node_executions");
    } finally {
      inspector.close();
    }
  });

  it("refuses to open a DB whose schema_version exceeds the binary's highest", async () => {
    const dbPath = path.join(dir, "future.db");
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    seed.prepare("INSERT INTO schema_version (version) VALUES (?)").run(99);
    seed.close();
    expect(() => SqliteRunStore.open(dbPath)).toThrow(MigrationVersionError);
  });

  it("appendEvent assigns monotonic seq starting at 0", async () => {
    const dbPath = path.join(dir, "runs.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "r1",
      factoryPath: "/x/f.yaml",
      factoryName: "f",
      startedAt: 1000,
    });
    const a = await store.appendEvent("r1", {
      nodeId: "n",
      iteration: 1,
      kind: "stdout",
      payload: { line: "a" },
      emittedAt: 10,
    });
    const b = await store.appendEvent("r1", {
      nodeId: "n",
      iteration: 1,
      kind: "stdout",
      payload: { line: "b" },
      emittedAt: 11,
    });
    const c = await store.appendEvent("r1", {
      nodeId: "n",
      iteration: 1,
      kind: "status",
      payload: { status: "succeeded" },
      emittedAt: 12,
    });
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
    const events = await store.getRunEvents("r1");
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events[0]?.payload).toEqual({ line: "a" });
  });

  it("concurrent writers against the same file all land with monotonic seq per run", async () => {
    const dbPath = path.join(dir, "runs.db");
    const sA = SqliteRunStore.open(dbPath);
    const sB = SqliteRunStore.open(dbPath);
    try {
      await sA.createRun({ id: "A", factoryPath: "/p", factoryName: "f", startedAt: 1 });
      await sB.createRun({ id: "B", factoryPath: "/p", factoryName: "f", startedAt: 2 });

      const pairs: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        pairs.push(
          sA.appendEvent("A", {
            nodeId: "n",
            iteration: 1,
            kind: "stdout",
            payload: { i },
            emittedAt: i,
          }),
        );
        pairs.push(
          sB.appendEvent("B", {
            nodeId: "n",
            iteration: 1,
            kind: "stdout",
            payload: { i },
            emittedAt: i,
          }),
        );
      }
      await Promise.all(pairs);

      const aEv = await sA.getRunEvents("A");
      const bEv = await sB.getRunEvents("B");
      expect(aEv.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(bEv.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally {
      await sA.close();
      await sB.close();
    }
  });

  it("finalizeRun records terminal status and listRuns filters work", async () => {
    const dbPath = path.join(dir, "runs.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "r1",
      factoryPath: "/x/f.yaml",
      factoryName: "alpha",
      change: "feat-a",
      startedAt: 1,
    });
    await store.createRun({
      id: "r2",
      factoryPath: "/x/g.yaml",
      factoryName: "beta",
      change: "feat-b",
      startedAt: 2,
    });
    await store.finalizeRun("r1", {
      status: "succeeded",
      reason: "terminal_node_succeeded",
      proximateNodeId: "t",
      endedAt: 100,
    });
    await store.finalizeRun("r2", {
      status: "failed",
      reason: "node_failed",
      proximateNodeId: "x",
      endedAt: 200,
    });

    const all = await store.listRuns();
    expect(all.map((r) => r.id)).toEqual(["r2", "r1"]);

    const alpha = await store.listRuns({ factoryName: "alpha" });
    expect(alpha.map((r) => r.id)).toEqual(["r1"]);

    const failed = await store.listRuns({ status: "failed" });
    expect(failed.map((r) => r.id)).toEqual(["r2"]);

    const r1 = await store.getRun("r1");
    expect(r1?.status).toBe("succeeded");
    expect(r1?.reason).toBe("terminal_node_succeeded");
  });

  it("recordNodeStart / recordNodeEnd bracket a node's row", async () => {
    const dbPath = path.join(dir, "runs.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "r1",
      factoryPath: "/p",
      factoryName: "f",
      startedAt: 0,
    });
    await store.recordNodeStart("r1", "a", 1, 5);
    await store.recordNodeEnd("r1", "a", 1, {
      status: "succeeded",
      sentinelStatus: "ok",
      exitCode: 0,
      at: 9,
    });
    const inspector = new DatabaseSync(dbPath);
    try {
      const row = inspector
        .prepare("SELECT * FROM node_executions WHERE run_id=? AND node_id=? AND iteration=?")
        .get("r1", "a", 1) as
        | { status: string; ended_at: number; sentinel_status: string }
        | undefined;
      expect(row?.status).toBe("succeeded");
      expect(row?.ended_at).toBe(9);
      expect(row?.sentinel_status).toBe("ok");
    } finally {
      inspector.close();
    }
  });
});
