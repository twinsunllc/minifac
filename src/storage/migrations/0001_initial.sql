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
