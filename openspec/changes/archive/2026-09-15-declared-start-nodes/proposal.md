## Why

A start node is today "a node with no `on_success` inbound edge". The
rule was written so that a recovery edge back into a cycle's entry
(`verify → propose` on failure) would not stop `propose` from
starting. Its other consequence: a node whose *only* inbound edges are
`on_failure` — an escalation, human-wait, or re-poll node — is also a
start node and is dispatched when the run begins. scarif-factory
FINDINGS F6 probed it (issue #36): `a → b`, `b → ask` (`on_failure`),
`b → z` ran `a ask`; `ask` ran before `b` ever failed and ended the
run. So no escalation node can exist in any factory graph unless it
also happens to have an `on_success` inbound edge.

## What Changes

- **MODIFIED** graph-runner "Start nodes": a start node is a node with
  **no inbound edge from another node, of any kind**, or a node that
  declares `start: true`. A self-loop is not an inbound edge for this
  purpose. A factory with zero start nodes is a load error that names
  the cycle the graph is entered through and the fix.
- **NEW** node-level `start: true` field on the factory schema
  (optional boolean, no default). Opt-in override for a node that has
  inbound edges but must also start at run begin — the entry of a
  cycle whose back-edge lands on it. Topology, not step payload: it
  survives step inlining and is replaced with the node under
  `extends:`.
- One shared computation (`startNodeIds`) used by the loader's
  validation and the runner's initial queue.
- No other dispatch semantics change.

### Breaking

A cycle whose entry node has a back-edge into it (`p → v`, `v → p` on
failure) needs `start: true` on `p`. The shipped `sdd.yaml` and
`hello.yaml` are unaffected. Five in-repo test fixtures were.

## Impact

- `src/factory/schema.ts` (`start`), `src/factory/start-nodes.ts`
  (new), `src/factory/cycles.ts` (`findEntryCycles`),
  `src/factory/loader.ts`, `src/runner/run.ts`, `src/step/inline.ts`
- Specs: `graph-runner` (MODIFIED Start nodes), `factory-schema`
  (ADDED Node `start:` field)
- Docs: ADR 0040, `docs/concepts/Factory.md`, `docs/concepts/Runner.md`
