import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (
    path: string,
  ) => {
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

  it("creates the DB file lazily and applies migrations through v3", async () => {
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
      expect(ver.v).toBe(3);
      const tables = inspector
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("runs");
      expect(names).toContain("events");
      expect(names).toContain("node_executions");
      expect(names).toContain("node_outputs");
      // branch_name column added by 0002.
      const cols = inspector.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("branch_name");
      // v3 index exists.
      const indexes = inspector
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain("idx_node_outputs_run_node_iter");
    } finally {
      inspector.close();
    }
  });

  it("applies 0002 to a pre-existing v1 database and preserves prior rows", async () => {
    const dbPath = path.join(dir, "preexisting.db");
    // Seed a v1 database manually: schema_version=1 with the v1 runs columns.
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    seed.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    seed.exec(`
      CREATE TABLE runs (
        id                TEXT PRIMARY KEY,
        factory_path      TEXT NOT NULL,
        factory_name      TEXT NOT NULL,
        brief_path        TEXT,
        change            TEXT,
        base_branch       TEXT,
        worktree_path     TEXT,
        status            TEXT NOT NULL,
        reason            TEXT,
        proximate_node_id TEXT,
        started_at        INTEGER NOT NULL,
        ended_at          INTEGER
      )`);
    seed.exec(`
      CREATE TABLE events (
        run_id     TEXT    NOT NULL,
        seq        INTEGER NOT NULL,
        node_id    TEXT,
        iteration  INTEGER NOT NULL,
        kind       TEXT    NOT NULL,
        payload    TEXT    NOT NULL,
        emitted_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      )`);
    seed.exec(`
      CREATE TABLE node_executions (
        run_id          TEXT    NOT NULL,
        node_id         TEXT    NOT NULL,
        iteration       INTEGER NOT NULL,
        status          TEXT    NOT NULL,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER,
        sentinel_status TEXT,
        exit_code       INTEGER,
        PRIMARY KEY (run_id, node_id, iteration)
      )`);
    seed
      .prepare(
        `INSERT INTO runs (id, factory_path, factory_name, status, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-1", "/p/f.yaml", "f", "succeeded", 1);
    seed.close();

    // Open via SqliteRunStore so it applies pending migrations.
    store = SqliteRunStore.open(dbPath);
    const row = await store.getRun("legacy-1");
    expect(row).not.toBeNull();
    expect(row?.branchName).toBeNull();

    const inspector = new DatabaseSync(dbPath);
    try {
      const ver = inspector
        .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version")
        .get() as { v: number };
      expect(ver.v).toBe(3);
      const cols = inspector.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("branch_name");
    } finally {
      inspector.close();
    }
  });

  it("createRun persists and round-trips branchName, listRuns surfaces it", async () => {
    const dbPath = path.join(dir, "bn.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "with-branch",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      change: "feat-a",
      branchName: "run/feat-a-abc123",
      startedAt: 1,
    });
    await store.createRun({
      id: "without-branch",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      change: "feat-b",
      startedAt: 2,
    });
    const a = await store.getRun("with-branch");
    expect(a?.branchName).toBe("run/feat-a-abc123");
    const b = await store.getRun("without-branch");
    expect(b?.branchName).toBeNull();
    const all = await store.listRuns();
    const byId = new Map(all.map((r) => [r.id, r]));
    expect(byId.get("with-branch")?.branchName).toBe("run/feat-a-abc123");
    expect(byId.get("without-branch")?.branchName).toBeNull();
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

describe("SqliteRunStore — node_outputs", () => {
  let dir: string;
  let store: SqliteRunStore | undefined;
  beforeEach(async () => {
    dir = await tmp("minifac-no-");
  });
  afterEach(async () => {
    if (store) {
      await store.close();
      store = undefined;
    }
  });

  it("recordNodeOutputs is a no-op on an empty index", async () => {
    const dbPath = path.join(dir, "no-op.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "r1",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      startedAt: 0,
    });
    await store.recordNodeOutputs("r1", "a", 1, {});
    const rows = await store.getNodeOutputs("r1");
    expect(rows).toEqual([]);
  });

  it("inserts one row per output key and round-trips via getNodeOutputs", async () => {
    const dbPath = path.join(dir, "ins.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "abc",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      startedAt: 0,
    });
    await store.recordNodeOutputs("abc", "propose", 1, {
      findings: { type: "value", path: "/a/f.json", size: 412, mtime: 1700000000000 },
      notes: { type: "value", path: "/a/n.json", size: 88, mtime: 1700000000005 },
    });
    const rows = await store.getNodeOutputs("abc");
    expect(rows.length).toBe(2);
    // Ordered by node_id ASC, iteration ASC, output_key ASC.
    expect(rows[0]?.outputKey).toBe("findings");
    expect(rows[1]?.outputKey).toBe("notes");
    expect(rows[0]?.outputType).toBe("value");
    expect(rows[0]?.path).toBe("/a/f.json");
    expect(rows[0]?.size).toBe(412);
    expect(rows[0]?.mtime).toBe(1700000000000);
  });

  it("getNodeOutputs filters by nodeId and iteration", async () => {
    const dbPath = path.join(dir, "filter.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "abc",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      startedAt: 0,
    });
    await store.recordNodeOutputs("abc", "propose", 1, {
      findings: { type: "value", path: "/p/1/f.json", size: 1, mtime: 1 },
    });
    await store.recordNodeOutputs("abc", "verify", 1, {
      results: { type: "value", path: "/v/1/r.json", size: 1, mtime: 1 },
    });
    await store.recordNodeOutputs("abc", "verify", 2, {
      results: { type: "value", path: "/v/2/r.json", size: 1, mtime: 1 },
    });
    const verifyIter2 = await store.getNodeOutputs("abc", { nodeId: "verify", iteration: 2 });
    expect(verifyIter2.length).toBe(1);
    expect(verifyIter2[0]?.path).toBe("/v/2/r.json");
    const allVerify = await store.getNodeOutputs("abc", { nodeId: "verify" });
    expect(allVerify.length).toBe(2);
    expect(allVerify.map((r) => r.iteration)).toEqual([1, 2]);
  });

  it("re-record with the same primary key replaces the row", async () => {
    const dbPath = path.join(dir, "replace.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "abc",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      startedAt: 0,
    });
    await store.recordNodeOutputs("abc", "verify", 1, {
      results: { type: "value", path: "/a/r.json", size: 100, mtime: 1 },
    });
    await store.recordNodeOutputs("abc", "verify", 1, {
      results: { type: "value", path: "/a/r.json", size: 120, mtime: 2 },
    });
    const rows = await store.getNodeOutputs("abc", { nodeId: "verify", iteration: 1 });
    expect(rows.length).toBe(1);
    expect(rows[0]?.size).toBe(120);
    expect(rows[0]?.mtime).toBe(2);
  });

  it("pre-v3 run returns an empty array (no rows)", async () => {
    const dbPath = path.join(dir, "empty.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "legacy",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      startedAt: 0,
    });
    const rows = await store.getNodeOutputs("legacy");
    expect(rows).toEqual([]);
  });

  it("deleteNodeOutputsForRun removes only the named run", async () => {
    const dbPath = path.join(dir, "del.db");
    store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "a",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      startedAt: 0,
    });
    await store.createRun({
      id: "b",
      factoryPath: "/p/f.yaml",
      factoryName: "f",
      startedAt: 0,
    });
    await store.recordNodeOutputs("a", "n", 1, {
      x: { type: "value", path: "/a/x.json", size: 1, mtime: 1 },
    });
    await store.recordNodeOutputs("b", "n", 1, {
      y: { type: "value", path: "/b/y.json", size: 1, mtime: 1 },
    });
    await store.deleteNodeOutputsForRun("a");
    expect((await store.getNodeOutputs("a")).length).toBe(0);
    expect((await store.getNodeOutputs("b")).length).toBe(1);
  });
});
