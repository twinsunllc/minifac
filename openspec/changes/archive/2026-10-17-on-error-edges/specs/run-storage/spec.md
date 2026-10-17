## ADDED Requirements

### Requirement: Schema v6 adds `outcome` to `node_executions`

minifac SHALL ship a sixth SQL migration
`src/storage/migrations/0006_add_node_outcome.sql` containing:

```sql
ALTER TABLE node_executions ADD COLUMN outcome TEXT;
```

mirrored as an entry in the inline `MIGRATIONS` array with
`version: 6` and `name: "add_node_outcome"`.

`RecordNodeEndInput` SHALL grow an optional `outcome?: NodeOutcome |
null`, persisted on both the update and the insert path (`NULL` when
omitted). `NodeExecutionRow` SHALL grow an optional `outcome`, read
back as the stored value or `null` (rows written before v6, skipped
nodes, and any stored value that is not a `NodeOutcome`). Both are
optional so a store or resume caller typed against an older minifac
still type-checks.

`resumeStateFromStore` SHALL set each rebuilt `NodeResult.outcome` from
its row's `outcome`, or, when the row has none, from its status
(`succeeded` → `success`, `failed` → `failure`).

#### Scenario: Fresh database picks up v6

- **WHEN** the adapter opens a brand-new database file
- **THEN** every migration through version `6` is applied and
  `schema_version.version` equals `6`

#### Scenario: Existing v5 database is migrated to v6

- **WHEN** the adapter opens a database at version `5` containing a
  `node_executions` row
- **THEN** the migration is applied, `schema_version.version` is `6`,
  and the existing row reads back with `outcome: null`

#### Scenario: recordNodeEnd round-trips the outcome

- **WHEN** the caller records `recordNodeEnd(runId, "a", 1, { status:
  "failed", outcome: "error", at })`
- **THEN** `getNodeExecutions(runId)` returns that row with
  `outcome: "error"`

#### Scenario: Resume rebuild carries the outcome

- **WHEN** a run's latest row for node A has `outcome: "error"`
- **THEN** `resumeStateFromStore` returns A's `NodeResult` with
  `outcome: "error"`
