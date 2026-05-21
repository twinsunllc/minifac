import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { MIGRATIONS, highestMigration } from "./migrations/index.js";

// `createRequire` avoids vitest/vite's pre-bundler stripping the `node:`
// prefix off the bare `node:sqlite` import. The built-in module is fully
// supported at runtime under Node 22; this is purely a test-tooling shim.
const nodeSqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncInstance;
};
const { DatabaseSync } = nodeSqlite;

// Loose mirror of the `node:sqlite` shape we use. The built-in's types
// aren't reliably bundled, so we re-declare what we touch.
interface DatabaseSyncInstance {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncInstance;
  close(): void;
}
interface StatementSyncInstance {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
import type {
  AppendEventInput,
  CreateRunInput,
  FinalizeRunInput,
  GetEventsOptions,
  ListRunsFilter,
  RecordNodeEndInput,
  RunId,
  RunStatus,
  RunStore,
  StoredEvent,
  StoredEventKind,
  StoredRun,
} from "./run-store.js";

/**
 * SQLite-backed RunStore using Node 22's built-in `node:sqlite`. WAL mode
 * is enabled at open so the CLI and the daemon can write concurrently.
 *
 * If `node:sqlite` lacks a feature we need later, the fallback is
 * `better-sqlite3`; the interface in `./run-store.ts` is async so the
 * swap is local.
 */

export class SqliteRunStore implements RunStore {
  private readonly db: DatabaseSyncInstance;

  private constructor(db: DatabaseSyncInstance) {
    this.db = db;
  }

  static open(filePath: string): SqliteRunStore {
    // Lazy-create parent dir so callers can hand us
    // `~/.minifac/runs.db` even on a fresh machine.
    const dir = path.dirname(filePath);
    if (dir && dir !== "." && dir !== path.sep) {
      mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseSync(filePath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    ensureSchemaVersionTable(db);
    runPendingMigrations(db);

    return new SqliteRunStore(db);
  }

  async createRun(input: CreateRunInput): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO runs
        (id, factory_path, factory_name, brief_path, change, base_branch,
         worktree_path, branch_name, status, reason, proximate_node_id, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)`,
    );
    stmt.run(
      input.id,
      input.factoryPath,
      input.factoryName,
      input.briefPath ?? null,
      input.change ?? null,
      input.baseBranch ?? null,
      input.worktreePath ?? null,
      input.branchName ?? null,
      input.startedAt,
    );
  }

  async appendEvent(runId: RunId, event: AppendEventInput): Promise<StoredEvent> {
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), -1) AS max_seq FROM events WHERE run_id = ?")
      .get(runId) as { max_seq: number } | undefined;
    const seq = (seqRow?.max_seq ?? -1) + 1;
    const payloadJson = JSON.stringify(event.payload ?? null);
    this.db
      .prepare(
        `INSERT INTO events (run_id, seq, node_id, iteration, kind, payload, emitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, seq, event.nodeId, event.iteration, event.kind, payloadJson, event.emittedAt);
    return {
      seq,
      nodeId: event.nodeId,
      iteration: event.iteration,
      kind: event.kind,
      payload: event.payload,
      emittedAt: event.emittedAt,
    };
  }

  async recordNodeStart(
    runId: RunId,
    nodeId: string,
    iteration: number,
    at: number,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO node_executions
          (run_id, node_id, iteration, status, started_at, ended_at, sentinel_status, exit_code)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL)`,
      )
      .run(runId, nodeId, iteration, at);
  }

  async recordNodeEnd(
    runId: RunId,
    nodeId: string,
    iteration: number,
    end: RecordNodeEndInput,
  ): Promise<void> {
    const existing = this.db
      .prepare(
        `SELECT started_at FROM node_executions
          WHERE run_id = ? AND node_id = ? AND iteration = ?`,
      )
      .get(runId, nodeId, iteration) as { started_at: number } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE node_executions
              SET status = ?, ended_at = ?, sentinel_status = ?, exit_code = ?
            WHERE run_id = ? AND node_id = ? AND iteration = ?`,
        )
        .run(
          end.status,
          end.at,
          end.sentinelStatus ?? null,
          end.exitCode ?? null,
          runId,
          nodeId,
          iteration,
        );
    } else {
      // Skipped nodes never had a start row.
      this.db
        .prepare(
          `INSERT INTO node_executions
            (run_id, node_id, iteration, status, started_at, ended_at, sentinel_status, exit_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          nodeId,
          iteration,
          end.status,
          end.at,
          end.at,
          end.sentinelStatus ?? null,
          end.exitCode ?? null,
        );
    }
  }

  async finalizeRun(runId: RunId, input: FinalizeRunInput): Promise<void> {
    this.db
      .prepare(
        `UPDATE runs
            SET status = ?, reason = ?, proximate_node_id = ?, ended_at = ?
          WHERE id = ?`,
      )
      .run(input.status, input.reason ?? null, input.proximateNodeId ?? null, input.endedAt, runId);
  }

  async getRun(runId: RunId): Promise<StoredRun | null> {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    return row ? rowToStoredRun(row as RunRow) : null;
  }

  async listRuns(filter?: ListRunsFilter): Promise<StoredRun[]> {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (filter?.factoryName !== undefined) {
      clauses.push("factory_name = ?");
      args.push(filter.factoryName);
    }
    if (filter?.change !== undefined) {
      clauses.push("change = ?");
      args.push(filter.change);
    }
    if (filter?.status !== undefined) {
      clauses.push("status = ?");
      args.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter?.limit ?? 20;
    const offset = filter?.offset ?? 0;
    args.push(limit, offset);
    const sql = `SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...args) as RunRow[];
    return rows.map(rowToStoredRun);
  }

  async getRunEvents(runId: RunId, opts?: GetEventsOptions): Promise<StoredEvent[]> {
    const sinceSeq = opts?.sinceSeq;
    const limit = opts?.limit;
    let sql = "SELECT * FROM events WHERE run_id = ?";
    const args: unknown[] = [runId];
    if (sinceSeq !== undefined) {
      sql += " AND seq > ?";
      args.push(sinceSeq);
    }
    sql += " ORDER BY seq ASC";
    if (limit !== undefined) {
      sql += " LIMIT ?";
      args.push(limit);
    }
    const rows = this.db.prepare(sql).all(...args) as EventRow[];
    return rows.map(rowToStoredEvent);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

interface RunRow {
  id: string;
  factory_path: string;
  factory_name: string;
  brief_path: string | null;
  change: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  status: RunStatus;
  reason: string | null;
  proximate_node_id: string | null;
  started_at: number;
  ended_at: number | null;
}

interface EventRow {
  run_id: string;
  seq: number;
  node_id: string | null;
  iteration: number;
  kind: StoredEventKind;
  payload: string;
  emitted_at: number;
}

function rowToStoredRun(r: RunRow): StoredRun {
  return {
    id: r.id,
    factoryPath: r.factory_path,
    factoryName: r.factory_name,
    briefPath: r.brief_path,
    change: r.change,
    baseBranch: r.base_branch,
    worktreePath: r.worktree_path,
    branchName: r.branch_name ?? null,
    status: r.status,
    reason: r.reason,
    proximateNodeId: r.proximate_node_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function rowToStoredEvent(r: EventRow): StoredEvent {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = r.payload;
  }
  return {
    seq: r.seq,
    nodeId: r.node_id,
    iteration: r.iteration,
    kind: r.kind,
    payload,
    emittedAt: r.emitted_at,
  };
}

function ensureSchemaVersionTable(db: DatabaseSyncInstance): void {
  // If `runs` exists but `schema_version` doesn't (shouldn't happen since v1
  // creates both), we still want the version table around so we can record
  // applied migrations. Creating it idempotently is harmless.
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)");
}

function currentSchemaVersion(db: DatabaseSyncInstance): number {
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version").get() as
    | { v: number }
    | undefined;
  return row?.v ?? 0;
}

function runPendingMigrations(db: DatabaseSyncInstance): void {
  const current = currentSchemaVersion(db);
  const highest = highestMigration();
  if (current > highest) {
    throw new MigrationVersionError(highest, current);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      // The shipped v1 migration creates `schema_version` itself; we
      // already created it above (idempotently) so re-running CREATE TABLE
      // would fail. Drop the redundant statement from v1 by handing the
      // SQL through unchanged — SQLite will error on the duplicate CREATE.
      // To keep the migration file canonical, we just guard once here:
      // if `schema_version` already has data we treat its existing CREATE
      // as a no-op. The simplest robust approach is to wrap each statement
      // in IF NOT EXISTS at apply time for table creates.
      const sql = applyIdempotentCreates(m.sql);
      db.exec(sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

function applyIdempotentCreates(sql: string): string {
  // Make CREATE TABLE / CREATE INDEX statements safe to re-run against a
  // database that already has the `schema_version` table from
  // `ensureSchemaVersionTable`. Other CREATEs become IF NOT EXISTS too, so a
  // partially-applied migration is safe to retry. Migrations remain the
  // source of truth for shape; this is purely about re-application.
  return sql
    .replace(/CREATE TABLE\s+(?!IF NOT EXISTS)/gi, "CREATE TABLE IF NOT EXISTS ")
    .replace(/CREATE INDEX\s+(?!IF NOT EXISTS)/gi, "CREATE INDEX IF NOT EXISTS ");
}

export class MigrationVersionError extends Error {
  constructor(
    readonly highestKnown: number,
    readonly databaseVersion: number,
  ) {
    super(
      `minifac runs.db schema version ${databaseVersion} is newer than this binary supports (highest known: ${highestKnown}). Upgrade minifac or point at an older runs.db.`,
    );
    this.name = "MigrationVersionError";
  }
}
