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

### Requirement: Schema v4 adds `session_id` to `node_executions`

minifac SHALL ship a fourth SQL migration
`src/storage/migrations/0004_add_session_id.sql` containing the
statement:

```sql
ALTER TABLE node_executions ADD COLUMN session_id TEXT;
```

The migration SHALL be mirrored as a string entry in the inline
`MIGRATIONS` array exported from `src/storage/migrations/index.ts`
with `version: 4` and `name: "add_session_id"`.

`session_id` SHALL hold the opaque executor session identifier the
graph-runner captured for that node execution (per the `graph-runner`
capability's "Per-dispatch session id capture" requirement), or
`NULL` when no session was announced — including for dispatches the
runner failed before spawning a child process. The column SHALL NOT
be unique: two node executions that continued one conversation
legitimately carry the same value, and the table's primary key
remains `(run_id, node_id, iteration)`.

The `RecordNodeEndInput` shape SHALL grow an optional
`sessionId?: string | null` field. The SQLite adapter's
`recordNodeEnd` implementation SHALL persist it into the
`session_id` column, binding `NULL` when the caller omits the field
or passes `null`. Any SELECT used by the public `RunStore` API that
projects node-execution rows SHALL surface the column as
`sessionId: string | null`.

The migration SHALL NOT touch other tables. After migration,
pre-v4 node-execution rows SHALL carry `session_id = NULL`
(SQLite's default for an added nullable column), and readers SHALL
tolerate `NULL` by surfacing it as `null` on the returned shape.

#### Scenario: Fresh database picks up v4 alongside earlier versions

- **WHEN** the adapter opens a brand-new database file
- **THEN** every migration through version `4` is applied in
  ascending order, the `node_executions` table includes the
  `session_id` column, and `schema_version.version` equals `4`

#### Scenario: Existing v3 database is migrated to v4

- **WHEN** the adapter opens an existing database whose
  `schema_version.version` is `3` and that contains rows in `runs`,
  `events`, `node_executions`, and `node_outputs` from prior runs
- **THEN** the `0004_add_session_id.sql` migration is applied in its
  own transaction, `schema_version.version` is updated to `4`, the
  `session_id` column exists on `node_executions`, the pre-existing
  node-execution rows carry `session_id = NULL`, and rows in other
  tables are unchanged

#### Scenario: recordNodeEnd persists the session id

- **WHEN** the caller invokes `recordNodeEnd(runId, "plan", 1, {
  status: "succeeded", sessionId: "abc-123", at: <ts> })`
- **THEN** a subsequent `SELECT session_id FROM node_executions
  WHERE run_id = ? AND node_id = 'plan' AND iteration = 1` returns
  the string `"abc-123"`

#### Scenario: recordNodeEnd without a session id persists null

- **WHEN** the caller invokes `recordNodeEnd` omitting `sessionId`
  (or passing `null`) — e.g. a dispatch the runner failed before
  spawn
- **THEN** the stored row's `session_id` is `NULL` and readers
  surface it as `null`

#### Scenario: Two node executions may share one session id

- **WHEN** node `plan` iteration 1 and node `apply` iteration 1 in
  the same run both record `sessionId: "abc-123"` (the second
  continued the first's conversation)
- **THEN** both rows persist successfully with the same `session_id`;
  the primary key `(run_id, node_id, iteration)` keeps them distinct
  and no uniqueness constraint is violated

#### Scenario: Pre-v4 rows read back as null

- **WHEN** the caller reads node-execution rows for a run id that
  predates v4
- **THEN** each returned row carries `sessionId: null`, not an error

### Requirement: Schema v5 adds the library pin to `runs`

minifac SHALL ship a fifth SQL migration
`src/storage/migrations/0005_add_run_library.sql` containing:

```sql
ALTER TABLE runs ADD COLUMN library_repo TEXT;
ALTER TABLE runs ADD COLUMN library_ref TEXT;
ALTER TABLE runs ADD COLUMN library_sha TEXT;
```

mirrored as an entry in the inline `MIGRATIONS` array with
`version: 5` and `name: "add_run_library"`.

`CreateRunInput` SHALL grow an optional `library?: { repo, ref, sha }
| null` field, persisted into the three columns (`NULL` when omitted
or `null`). `StoredRun` SHALL grow `library: { repo, ref, sha } |
null`, non-null only when all three columns are set. Pre-v5 rows
SHALL read back with `library: null`. `minifac runs --json` SHALL
include each run's `library`.

#### Scenario: Fresh database picks up v5

- **WHEN** the adapter opens a brand-new database file
- **THEN** every migration through version `5` is applied, the
  `runs` table has `library_repo`, `library_ref`, and `library_sha`,
  and `schema_version.version` equals `5`

#### Scenario: Existing v4 database is migrated to v5

- **WHEN** the adapter opens a database at version `4` containing a
  run row
- **THEN** the migration is applied, `schema_version.version` is `5`,
  and the existing run reads back with `library: null`

#### Scenario: createRun round-trips the pin

- **WHEN** the caller creates a run with `library: { repo:
  "acme/lib", ref: "v0.1.0", sha: <40 hex> }`
- **THEN** `getRun` and `listRuns` return that `library` value

### Requirement: Resume-state reconstruction

The `RunStore` interface SHALL declare two further OPTIONAL methods
and one further read option:

- `getNodeExecutions(runId): Promise<NodeExecutionRow[]>` — every
  `node_executions` row of a run, carrying `nodeId`, `iteration`,
  `status` (`running` | `succeeded` | `failed` | `skipped`),
  `startedAt`, `endedAt` and `sessionId`.
- `reopenRun(runId): Promise<void>` — put a finished run back to
  `running`, clearing `ended_at`, `reason` and `proximate_node_id`, so
  a resumed segment appends to the same row. A no-op for an unknown
  run id.
- `GetEventsOptions.kind` — return only events of the named kind. A
  HINT: an adapter that cannot filter MAY ignore it, so a caller that
  needs the guarantee filters again.

Both methods are OPTIONAL for the same reason
`deleteNodeOutputsForRun` is: the droid's adapter in
twinsunllc/scarif-worker is assignable to this interface by shape
alone, and a required method would break its build the moment this
one shipped. The SQLite adapter SHALL implement all three.

`resumeStateFromStore({ store, runId, at, feedback })` SHALL rebuild a
finished run's `ResumeState` from those rows:

- One `priorResults` entry per node, from that node's LATEST ENDED
  iteration — the same latest-wins rule the runner's own prior-results
  map applies. A `running` or `skipped` row contributes no entry.
- Each entry's `outputs` SHALL be the `NodeOutputIndex` assembled from
  the `node_outputs` rows of that exact `(node, iteration)`, or `null`
  when there are none.
- Each entry's `reason` SHALL be recovered from the run's persisted
  `status` events for that `(node, iteration)`, applying the same
  extraction rule the runner applies live (a `sentinel_failed` meta's
  `sentinel` string, else a categorical `meta.reason`); `null` for a
  succeeded node and for a failed node whose status event is no longer
  in the log. `node_executions` has no reason column, and
  `{{ priorResults.<id>.reason }}` is exactly what an
  escalation-aware step reads, so dropping it would rebuild a worse
  state than the run had.
- Each entry's `startedAt` / `endedAt` SHALL be rebased onto
  ms-since-run-start, so a rehydrated entry is on the same scale as
  one the resumed run produces itself.
- `iterations` SHALL carry, per node, the HIGHEST iteration any row
  mentions — including a `running` or `skipped` row, because that
  dispatch still spent its slot.
- `feedback` SHALL be carried when supplied and the key SHALL be
  ABSENT when it is not.

An unknown run id, and a store that does not implement
`getNodeExecutions`, SHALL each raise `ResumeStateError` with a
sentence naming the problem.

#### Scenario: A finished run's state is rebuilt

- **WHEN** a run's store holds `plan` iterations 1 (failed) and 2
  (succeeded, with a `result` output) and `evaluate` iteration 1
  (failed, status event carrying sentinel
  `"escalate: AC-13 cannot be proved pre-merge"`)
- **THEN** `resumeStateFromStore` returns two `priorResults` entries —
  `plan` at iteration 2 with its outputs index, and `evaluate` at
  iteration 1 with `reason: "escalate: AC-13 cannot be proved pre-merge"` —
  and `iterations` `{ plan: 2, evaluate: 1 }`

#### Scenario: A skipped node contributes an iteration count but no result

- **WHEN** a run's store holds only a `skipped` row for node `verify`
- **THEN** `iterations.verify` is that row's iteration and no
  `priorResults` entry names `verify`

#### Scenario: A finished run is reopened

- **WHEN** `reopenRun` is called for a run whose row is `failed` with
  a reason, a proximate node and an `ended_at`
- **THEN** the row reads `status: "running"` with all three cleared

#### Scenario: An unknown run id is refused

- **WHEN** `resumeStateFromStore` is called with a run id the store
  does not hold
- **THEN** it raises `ResumeStateError` naming the id
