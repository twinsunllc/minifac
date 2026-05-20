# run-storage Specification

## Purpose
TBD - created by archiving change run-history-persistence. Update Purpose after archive.
## Requirements
### Requirement: `RunStore` interface

minifac SHALL define a `RunStore` interface that captures the
durable contract between the runner (and the daemon) and the
underlying storage backend. The interface SHALL be small,
async on every method, and expose at minimum:

- `createRun(input)` — record a new run with its starting
  metadata (id, factory path, factory name, optional brief path,
  optional change name, optional base branch, optional worktree
  path, started_at timestamp).
- `appendEvent(runId, event)` — append one event to a run; the
  store SHALL assign a monotonically increasing per-run `seq`
  beginning at `0` and return the stored event.
- `recordNodeStart(runId, nodeId, iteration, at)` and
  `recordNodeEnd(runId, nodeId, iteration, end)` — bracket each
  node's dispatch with status / duration metadata.
- `finalizeRun(runId, input)` — mark the run terminal with
  status (`succeeded` | `failed`), reason, optional proximate
  node id, and ended_at timestamp.
- `getRun(runId)`, `listRuns(filter)`, `getRunEvents(runId,
  { sinceSeq?, limit? })` — read paths.
- `close()` — release any underlying resources.

The interface SHALL be the only persistence contract the runner
and the daemon depend on. Callers SHALL NOT depend on the
SQLite-specific details of the v0 adapter.

#### Scenario: A new adapter can satisfy the interface without changing callers

- **WHEN** a contributor implements a second adapter (e.g. an
  in-memory adapter for tests, or a future remote adapter) that
  satisfies the `RunStore` interface
- **THEN** the runner and the daemon use it without source
  changes — only the construction site that picks an adapter
  changes

#### Scenario: appendEvent assigns monotonic seq per run

- **WHEN** a caller invokes `appendEvent` three times against
  the same run id
- **THEN** the returned `seq` values are `0`, `1`, `2` in call
  order; the same `seq` is what `getRunEvents` returns later

#### Scenario: Optional store does not require call sites to construct one

- **WHEN** a caller invokes the runner without a `store`
  argument (e.g. a unit test of `runFactory`)
- **THEN** the runner runs to completion without attempting any
  storage call and without erroring

### Requirement: SQLite adapter is the only shipped adapter

minifac SHALL ship exactly one `RunStore` adapter in v0: a
SQLite-backed adapter at the file path resolved from
configuration. The adapter SHALL:

- Open the database with `PRAGMA journal_mode=WAL` so multiple
  writer processes (CLI and daemon) can coexist without manual
  coordination.
- Open the database with `PRAGMA foreign_keys=ON` for referential
  integrity on `events` and `node_executions`.
- Encode `events.payload` and any JSON-shaped field as a TEXT
  column containing the JSON encoding.
- Create the database file (and any parent directories under the
  resolved `runs_db` path) lazily on first open if it does not
  exist.

The adapter SHALL be the only implementation in the v0 source
tree. A future Dolt, HTTP, or other adapter is out of scope.

#### Scenario: WAL mode is enabled at open

- **WHEN** the SQLite adapter opens the database file for the
  first time
- **THEN** the journal mode is `wal` (verifiable via
  `PRAGMA journal_mode;`)

#### Scenario: Database file is created lazily

- **WHEN** the adapter opens a path whose containing directory
  exists but whose file does not
- **THEN** the file is created on first open and the v1 schema
  is applied; subsequent opens reuse the existing file

#### Scenario: Concurrent writers do not corrupt the DB

- **WHEN** two processes (a `minifac run` invocation and the
  `minifac serve` daemon) both call `appendEvent` against
  different runs concurrently
- **THEN** every appended event is persisted, no row is lost,
  and per-run `seq` values remain monotonic within each run

### Requirement: Schema migrations apply at startup

minifac SHALL maintain a numbered SQL migration mechanism for
the SQLite adapter. Migration files SHALL live at
`src/storage/migrations/NNNN_<name>.sql` and SHALL be applied in
ascending order by `NNNN` at adapter open. The adapter SHALL
track the current schema version in a `schema_version` table.

The adapter SHALL apply each pending migration in its own
transaction. On a fresh database, the adapter SHALL apply every
known migration and SHALL leave `schema_version.version` set to
the highest applied number.

If the database carries a `schema_version.version` greater than
the highest migration the binary knows about, the adapter SHALL
refuse to open and SHALL surface a clear error naming the
expected and actual versions.

#### Scenario: Fresh database receives all migrations

- **WHEN** the adapter opens a brand-new database file
- **THEN** every migration in `src/storage/migrations/` is
  applied in ascending order, the `schema_version.version` row
  matches the highest migration's number, and the database is
  ready for use

#### Scenario: Older database receives only pending migrations

- **WHEN** the adapter opens a database whose
  `schema_version.version` is N and the binary carries
  migrations through N+2
- **THEN** the adapter applies migrations N+1 and N+2 (in that
  order), each in its own transaction, and leaves
  `schema_version.version` at N+2

#### Scenario: Newer database is refused

- **WHEN** the adapter opens a database whose
  `schema_version.version` is greater than the highest migration
  the binary carries
- **THEN** the adapter raises an error naming both versions and
  does NOT mutate the database

### Requirement: Initial schema (v1)

The first migration (`0001_initial.sql`) SHALL define at minimum
the following tables:

- `schema_version (version INTEGER PRIMARY KEY)`.
- `runs` with columns `id` (TEXT PK), `factory_path` (TEXT NOT
  NULL), `factory_name` (TEXT NOT NULL), `brief_path` (TEXT
  NULL), `change` (TEXT NULL), `base_branch` (TEXT NULL),
  `worktree_path` (TEXT NULL), `status` (TEXT NOT NULL,
  enum-by-convention `running` | `succeeded` | `failed`),
  `reason` (TEXT NULL), `proximate_node_id` (TEXT NULL),
  `started_at` (INTEGER NOT NULL, epoch ms), `ended_at` (INTEGER
  NULL).
- `events` with columns `run_id` (TEXT), `seq` (INTEGER),
  `node_id` (TEXT NULL), `iteration` (INTEGER NOT NULL), `kind`
  (TEXT NOT NULL, enum-by-convention `stdout` | `stderr` |
  `status` | `run_end`), `payload` (TEXT NOT NULL, JSON-encoded),
  `emitted_at` (INTEGER NOT NULL), with a composite primary key
  on `(run_id, seq)`.
- `node_executions` with columns `run_id` (TEXT), `node_id`
  (TEXT), `iteration` (INTEGER), `status` (TEXT NOT NULL),
  `started_at` (INTEGER NOT NULL), `ended_at` (INTEGER NULL),
  `sentinel_status` (TEXT NULL), `exit_code` (INTEGER NULL),
  with a composite primary key on `(run_id, node_id,
  iteration)`.

The migration SHALL also create indexes on `runs.started_at`
(descending), `runs.factory_name` + `runs.started_at`, and
`runs.change` + `runs.started_at` to support the listing filters.

#### Scenario: v1 schema is what gets applied to a fresh DB

- **WHEN** the adapter opens a fresh database
- **THEN** the three tables (`runs`, `events`,
  `node_executions`) and the documented indexes exist, and
  `schema_version.version` is `1`

### Requirement: Configurable storage location

The SQLite adapter SHALL resolve its file path in the following
order:

1. An explicit path passed by the constructing caller (CLI,
   daemon, or test) MUST win.
2. Otherwise, the `runs_db` field of the merged minifac config
   (per-repo `<repo>/.minifac/config.yaml` overriding global
   `~/.minifac/config.yaml`) MUST be used when present.
3. Otherwise, the default `${MINIFAC_HOME}/runs.db` MUST be
   used, where `MINIFAC_HOME` is the existing root (env override
   → `~/.minifac`).

The `runs_db` field SHALL be a non-empty string when present;
empty strings or non-string values SHALL produce a config load
error naming the field and source path. Relative paths SHALL be
resolved against the config file's directory; absolute paths
SHALL be honored verbatim.

#### Scenario: Default path is `~/.minifac/runs.db`

- **WHEN** no `runs_db` is configured and no explicit path is
  passed
- **THEN** the adapter opens `${MINIFAC_HOME}/runs.db` (i.e.
  `~/.minifac/runs.db` when `MINIFAC_HOME` is unset)

#### Scenario: Global config override is honored

- **WHEN** `~/.minifac/config.yaml` contains `runs_db: /tmp/x.db`
  and no per-repo override exists
- **THEN** the adapter opens `/tmp/x.db`

#### Scenario: Per-repo config beats global

- **WHEN** `~/.minifac/config.yaml` sets `runs_db: /tmp/global.db`
  and `<repo>/.minifac/config.yaml` sets `runs_db: ./local.db`
- **THEN** the adapter opens `<repo>/.minifac/local.db` (the
  per-repo relative path resolved against the per-repo config's
  directory)

#### Scenario: Empty or non-string runs_db is a config error

- **WHEN** any config file sets `runs_db:` to the empty string,
  a non-string value, or omits the value
- **THEN** loading the config raises an error naming the field
  and the source path; no adapter is opened

