## Why

An edge takes only `when: on_success | on_failure`, so a node that
crashed, hit a rate limit or timed out routes exactly like a node that
judged "revise", and a runner error sends the run around a revise loop
(scarif-factory FINDINGS F3 and F10; twinsunllc/minifac#37, first half;
SCARIFW-2247).

## What Changes

- **MODIFIED** `factory-schema` "Edge definition": `when` accepts
  `on_error` beside `on_success` and `on_failure`; an unknown value is
  rejected with an error listing all three.
- **ADDED** `factory-schema` "Cycles closed by `on_error` edges need a
  budget" (the existing rule, pinned for the new kind).
- **MODIFIED** `graph-runner` "Edge traversal honors `when` condition":
  each dispatch has an outcome (`success | failure | error`); an error
  takes the node's `on_error` edges when it declares any, and its
  `on_failure` edges otherwise; a judged failure never takes `on_error`.
- **ADDED** `graph-runner` "Node outcome classification and records":
  the runner's own error paths, `NodeResult.outcome`,
  `ExecutionLogEntry.outcome`, and `outcome` on every terminal status
  event it delivers.
- **ADDED** `node-executor` "Terminal status outcome": the optional
  `outcome` on a `status` event, and the claude, command and check-merge
  mappings.
- **ADDED** `run-storage` "Schema v6 adds `outcome` to
  `node_executions`", with resume rebuild.

## Impact

- `src/factory/schema.ts`, `src/executor/{types,claude,command,check-merge}.ts`,
  `src/runner/{run,result,resume}.ts`, `src/storage/{run-store,sqlite}.ts`,
  `src/storage/migrations/`.
- Additive for graphs: one with no `on_error` edge routes as before.
- runs.db goes to v6; an older build refuses a v6 database.
- A claude result with `is_error: true` and no sentinel is now `failed`
  even on exit 0.
- Decision record: `docs/decisions/0052-On-Error-Edges.md`.
