## ADDED Requirements

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
