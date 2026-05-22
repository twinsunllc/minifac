/**
 * Ordered SQL migrations applied at adapter open. Each entry's `version`
 * matches the file stem (e.g. `0001_initial.sql` → version 1). The
 * adapter applies in ascending order any migration whose version is
 * greater than the current `schema_version.version`, each in its own
 * transaction.
 *
 * The canonical SQL source-of-truth files live alongside this index
 * (`0001_initial.sql`, …). The inline strings here are kept in sync so
 * the package can ship without a copy-assets build step.
 */

const SQL_0001 = `
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);

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
);

CREATE INDEX runs_started_at_idx ON runs (started_at DESC);
CREATE INDEX runs_factory_idx    ON runs (factory_name, started_at DESC);
CREATE INDEX runs_change_idx     ON runs (change,       started_at DESC);

CREATE TABLE events (
  run_id     TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  node_id    TEXT,
  iteration  INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  payload    TEXT    NOT NULL,
  emitted_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE node_executions (
  run_id          TEXT    NOT NULL,
  node_id         TEXT    NOT NULL,
  iteration       INTEGER NOT NULL,
  status          TEXT    NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  sentinel_status TEXT,
  exit_code       INTEGER,
  PRIMARY KEY (run_id, node_id, iteration),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
`;

const SQL_0002 = `
ALTER TABLE runs ADD COLUMN branch_name TEXT;
`;

const SQL_0003 = `
CREATE TABLE node_outputs (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  output_key TEXT NOT NULL,
  output_type TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id, iteration, output_key)
);

CREATE INDEX idx_node_outputs_run_node_iter
  ON node_outputs (run_id, node_id, iteration);
`;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: "initial", sql: SQL_0001 },
  { version: 2, name: "add_branch_name", sql: SQL_0002 },
  { version: 3, name: "add_node_outputs", sql: SQL_0003 },
]);

export function highestMigration(): number {
  return MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
}
