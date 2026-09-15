## ADDED Requirements

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
