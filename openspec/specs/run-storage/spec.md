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
  path, **optional branch name**, started_at timestamp).
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

The `createRun` input SHALL accept an optional `branchName`
string. The shape returned by `getRun` and `listRuns` SHALL
carry a `branchName: string | null` field; rows that pre-date
this field (or that were created without a branch name) SHALL
return `null`.

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

#### Scenario: createRun persists branchName when supplied

- **WHEN** the caller invokes `createRun` with a `branchName`
  of `"run/foo-a7b3c1"` alongside the other required fields
- **THEN** the row returned by a subsequent `getRun(id)` carries
  `branchName: "run/foo-a7b3c1"`

#### Scenario: createRun without branchName persists null

- **WHEN** the caller invokes `createRun` omitting the
  `branchName` field
- **THEN** the row returned by a subsequent `getRun(id)` carries
  `branchName: null`; queries via `listRuns` likewise return
  `null` for that row's `branchName`

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

### Requirement: Schema v2 adds `branch_name` to runs

minifac SHALL ship a second SQL migration
`src/storage/migrations/0002_add_branch_name.sql` containing the
statement:

```sql
ALTER TABLE runs ADD COLUMN branch_name TEXT;
```

The migration SHALL be mirrored as a string entry in the inline
`MIGRATIONS` array exported from `src/storage/migrations/index.ts`
with `version: 2` and `name: "add_branch_name"`.

The SQLite adapter's `createRun` implementation SHALL include
`branch_name` in the INSERT column list and bind the input value
(or `NULL` when the caller omitted `branchName`). The
`getRun`, `listRuns`, and any other SELECT used by the public
`RunStore` API SHALL project the `branch_name` column into the
returned object's `branchName` field.

After migration, existing rows SHALL carry `branch_name = NULL`
(SQLite's default for an added nullable column). Readers SHALL
tolerate `NULL` by surfacing it as `null` on the returned shape.

#### Scenario: Fresh database picks up v2 alongside v1

- **WHEN** the adapter opens a brand-new database file
- **THEN** every migration through version `2` is applied in
  ascending order, the `runs` table includes the `branch_name`
  column, and `schema_version.version` equals `2`

#### Scenario: Existing v1 database is migrated to v2

- **WHEN** the adapter opens an existing database whose
  `schema_version.version` is `1` and that contains rows in
  `runs` from prior runs
- **THEN** the `0002_add_branch_name.sql` migration is applied
  in its own transaction, `schema_version.version` is updated to
  `2`, the `branch_name` column exists on `runs`, and the
  pre-existing rows have `branch_name = NULL`

#### Scenario: createRun INSERTs branch_name

- **WHEN** the SQLite adapter's `createRun` is called with
  `branchName: "run/foo-a7b3c1"` and the other required fields
- **THEN** a subsequent `SELECT branch_name FROM runs WHERE id =
  ?` returns the string `"run/foo-a7b3c1"`

#### Scenario: listRuns surfaces branchName on each row

- **WHEN** the caller invokes `listRuns({})` against a store
  containing rows with mixed `branch_name` values (some null,
  some set)
- **THEN** each returned object carries `branchName` equal to
  the row's stored value (`null` or the string verbatim)

### Requirement: Schema v3 adds `node_outputs` table

minifac SHALL ship a third SQL migration
`src/storage/migrations/0003_add_node_outputs.sql` containing the
statement:

```sql
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
```

The migration SHALL be mirrored as a string entry in the inline
`MIGRATIONS` array exported from `src/storage/migrations/index.ts`
with `version: 3` and `name: "add_node_outputs"`.

`output_type` SHALL hold one of the literal strings `"value"`,
`"file"`, or `"directory"` (enum-by-convention; not enforced at
the SQL layer). `path` SHALL hold the absolute filesystem path of
the produced output. `size` and `mtime` SHALL hold the values
recorded by the graph-runner's outputs validator (per the
`graph-runner` capability's "Post-execution outputs validation"
requirement): for `value` and `file` types, the file's size in
bytes and mtime in epoch ms; for `directory` types, the recursive
sum of contained files' sizes and the latest contained file's
mtime.

The migration SHALL NOT touch existing tables. After migration,
old runs (pre-v3) SHALL have no rows in `node_outputs`; readers
SHALL surface this as an empty outputs index for the run.

#### Scenario: Fresh database picks up v3 alongside earlier versions

- **WHEN** the adapter opens a brand-new database file
- **THEN** every migration through version `3` is applied in
  ascending order, the `node_outputs` table exists with the
  documented columns and primary key, the
  `idx_node_outputs_run_node_iter` index exists, and
  `schema_version.version` equals `3`

#### Scenario: Existing v2 database is migrated to v3

- **WHEN** the adapter opens an existing database whose
  `schema_version.version` is `2` and that contains rows in
  `runs`, `events`, and `node_executions` from prior runs
- **THEN** the `0003_add_node_outputs.sql` migration is applied
  in its own transaction, `schema_version.version` is updated to
  `3`, the `node_outputs` table exists, and the pre-existing
  rows in other tables are unchanged

#### Scenario: Pre-v3 runs surface as empty outputs

- **WHEN** the caller invokes `getNodeOutputs(runId, ...)` for a
  run id that predates v3 (no rows in `node_outputs` for that
  run)
- **THEN** the call returns an empty map (or empty array, per the
  method's documented shape), not an error

### Requirement: `recordNodeOutputs` and `getNodeOutputs` on `RunStore`

The `RunStore` interface SHALL grow two methods:

```ts
recordNodeOutputs(
  runId: string,
  nodeId: string,
  iteration: number,
  outputs: NodeOutputIndex
): void | Promise<void>;

getNodeOutputs(
  runId: string,
  filter?: { nodeId?: string; iteration?: number }
): NodeOutputRow[] | Promise<NodeOutputRow[]>;
```

where:

- `NodeOutputIndex` is `Record<string, { type: "value" | "file"
  | "directory"; path: string; size: number; mtime: number }>`
  (matching the `graph-runner` capability's shape).
- `NodeOutputRow` is
  `{ runId: string; nodeId: string; iteration: number;
  outputKey: string; outputType: "value" | "file" | "directory";
  path: string; size: number; mtime: number }`.

The SQLite adapter SHALL implement these by INSERTing one row per
key in the supplied `outputs` map (per node iteration) and by
SELECTing from the `node_outputs` table with the optional filters
applied. `recordNodeOutputs` SHALL be idempotent on
`(run_id, node_id, iteration, output_key)`: re-recording with the
same key (e.g. when a re-dispatch happens to overwrite the same
iteration) SHALL replace the row (`INSERT OR REPLACE` semantics)
rather than fail on the primary-key constraint.

`getNodeOutputs` results SHALL be ordered by `(node_id ASC,
iteration ASC, output_key ASC)` so callers (the CLI in
particular) get deterministic output without an explicit sort.

When the supplied `outputs` map is empty, `recordNodeOutputs`
SHALL be a no-op (no rows inserted, no error raised). This lets
the graph-runner unconditionally call the method for every node
end regardless of whether outputs were produced.

The graph-runner SHALL invoke `recordNodeOutputs` after the
outputs validation pass completes and before `recordNodeEnd` is
invoked for the same node iteration. The two calls SHALL share
the same notion of `(runId, nodeId, iteration)`; the store SHALL
NOT enforce a foreign-key relationship between `node_outputs`
and `node_executions` (the latter table's primary key is the
canonical anchor; the v0 SQLite adapter uses no FK constraints).

#### Scenario: recordNodeOutputs inserts one row per key

- **WHEN** the runner invokes `recordNodeOutputs("abc", "propose",
  1, { findings: { type: "value", path: "/a/f.json", size: 412,
  mtime: 1700000000000 }, notes: { type: "value", path:
  "/a/n.json", size: 88, mtime: 1700000000005 } })`
- **THEN** two rows are inserted into `node_outputs` with
  `(run_id="abc", node_id="propose", iteration=1)` and the
  respective output keys, types, paths, sizes, and mtimes

#### Scenario: getNodeOutputs filters by node and iteration

- **WHEN** the caller invokes
  `getNodeOutputs("abc", { nodeId: "verify", iteration: 2 })`
  against a store containing outputs for multiple nodes and
  iterations of the same run
- **THEN** the returned rows are exactly those with
  `(run_id="abc", node_id="verify", iteration=2)`, ordered by
  `output_key ASC`

#### Scenario: getNodeOutputs with no filter returns all rows for the run

- **WHEN** the caller invokes `getNodeOutputs("abc")` against a
  store with rows for `propose/1`, `verify/1`, `verify/2`,
  `apply/1` of run `"abc"` and rows for an unrelated run
- **THEN** the returned rows are exactly the four `"abc"` rows
  ordered by `(node_id ASC, iteration ASC, output_key ASC)`;
  the unrelated run's rows are not returned

#### Scenario: Empty outputs map is a no-op

- **WHEN** the runner invokes `recordNodeOutputs("abc", "noop",
  1, {})` for a node that declared no outputs (or whose outputs
  validation produced an empty index)
- **THEN** no rows are inserted; no error is raised; a subsequent
  `getNodeOutputs("abc", { nodeId: "noop" })` returns an empty
  array

#### Scenario: Re-record with the same key replaces the row

- **WHEN** the runner invokes `recordNodeOutputs("abc", "verify",
  1, { results: { type: "value", path: "/a/r.json", size: 100,
  mtime: T1 } })` and later (e.g. on adapter retry) invokes the
  same call with `size: 120, mtime: T2`
- **THEN** a subsequent `getNodeOutputs("abc", { nodeId:
  "verify", iteration: 1 })` returns a single row with
  `size: 120, mtime: T2`; no primary-key conflict error is
  raised

