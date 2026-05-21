## MODIFIED Requirements

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

## ADDED Requirements

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
