## Why

An edge branches only on its node's outcome (`on_success`, `on_failure`,
`on_error`), so a three-way verdict (evaluate → implement | verify |
escalate) cannot be written (twinsunllc/minifac#37, second half;
SCARIFW-2251). #54 asks for node-chosen routing within an allow-list. Both
route on a node's result, so ADR 0055 designs them together. This change
implements value edges; `routes:`/`next:` follows in SCARIFW-2252.

## What Changes

- **MODIFIED** `factory-schema` "Edge definition": `when` may be a value
  condition, `{ output: <key>[.<prop>...], equals: <scalar> }` or
  `{ output: ..., in: [<scalar>, ...] }`, with exactly one operator.
- **ADDED** `factory-schema` "Value edge load-time validation": the key must
  be a declared `type: value` output of `from`; a path or value its
  `schema:` rules out is a load error; same-path overlapping value edges
  from one node are a load error naming both. Value edges count for cycle
  budgets like any edge.
- **MODIFIED** `graph-runner` "Edge traversal honors `when` condition": on
  a success or a judged failure, matching value edges replace the outcome's
  edges; with none matching, the outcome's edges are taken and a stderr
  line records the miss; an error never takes a value edge; a matched but
  exhausted edge does not fall back. Value-edge traversal keys are
  `<from>-><to>:output:<path>=<JSON>` / `... in <JSON array>`, carried
  through park/resume.

## Impact

- `src/factory/value-edges.ts` (new), `src/factory/schema.ts`,
  `src/factory/loader.ts`, `src/factory/cycles.ts`, `src/runner/run.ts`,
  `src/index.ts`, `src/serve/web/*`.
- `FactoryEdge["when"]` widens to a union with an object. Graphs using only
  outcome literals load and route as before, with unchanged edge keys. No
  runs.db schema change.
- Decision record: `docs/decisions/0055-Value-Edges-And-Node-Routing.md`.
