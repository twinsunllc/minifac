## Why

ADR 0055 designed node-chosen routing beside value edges: a judging node
names its next node itself, within a declared allow-list
(twinsunllc/minifac#54; SCARIFW-2252). Today an evaluate that finds only a
lint problem still goes all the way round implement → checks_gate → review
→ evaluate. Value edges shipped in SCARIFW-2251; this change builds
`routes:`/`next:` to the ADR's design.

## What Changes

- **ADDED** `factory-schema` "Node routes": a node may declare
  `routes: [<id> | { to: <id>, max_traversals: <n> }, ...]` (workflow only;
  a step may not). The loader synthesizes a non-required `type: value`
  output `next` with schema `{ enum: [<route ids>..., null] }`; a routing
  node that already has a `next` output is a load error. A route naming an
  undeclared node, or whose target has no path to a `terminal: true` node,
  is a load error. Routes count as edges for start-node inference and cycle
  budgets (ADR 0053).
- **MODIFIED** `graph-runner` "Edge traversal honors `when` condition":
  precedence `next` > value edges > outcome edges on a success or a judged
  failure; an error ignores `next`; a chosen route that is exhausted does
  not fall back. A route's traversal key is `<from>-><to>:route`, carried
  through park/resume and `via`.
- **ADDED** `graph-runner` "Routed hop run record": each route traversed is
  emitted and persisted as a `runner-action` event whose line contains
  `chosen_by: <node id>` and whose payload carries `chosen_by` and `to`.

Two parts go beyond ADR 0055's text, and the ADR is amended in this change:
the terminal-reachability load error (the ADR's question 2 said "no new
rule") and the `chosen_by` event (the ADR said routes add nothing to the
runner).

## Impact

- `src/factory/routes.ts` (new), `src/factory/schema.ts`,
  `src/factory/loader.ts`, `src/factory/start-nodes.ts`,
  `src/factory/cycles.ts`, `src/factory/value-edges.ts` (key type),
  `src/step/inline.ts`, `src/runner/run.ts`, `src/executor/types.ts`,
  `src/index.ts`, `src/serve/web/*`, `examples/routing.yaml`.
- A graph without `routes:` loads and routes as before: no synthesized
  output, unchanged edge keys, start nodes and cycle results. No runs.db
  schema change; the event's extra payload fields are additive.
- An older minifac refuses a factory declaring `routes:` (strict node
  schema), so roll back factories before minifac.
