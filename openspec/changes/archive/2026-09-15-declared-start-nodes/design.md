## Context

The runner and the loader each computed start nodes independently
(`src/runner/run.ts` ~L192 and `validatePostSchema` in
`src/factory/loader.ts`), both as "not the target of an `on_success`
edge". The graph-runner spec's "Start nodes" requirement says the same
and adds: "a node whose only inbound edges are `on_failure` is still
an entry point for the forward flow." That sentence is the defect.

## Decisions

**Inference over all edge kinds, with an opt-in override.** Pure
inference cannot tell a cycle's entry from a cycle's escalation
target: both are `on_failure` targets, and the entry has an inbound
edge by construction. So: infer "no inbound edge from another node"
(covers every linear and fan graph unchanged), and let the author
declare `start: true` for the one case inference cannot see. Full
rationale and rejected alternatives in ADR 0040.

**Self-loops do not count as inbound.** `a → a` cannot make `a`
reachable from elsewhere. Counting it would turn the shipped
bounded-retry idiom into a zero-start-node error.

**Zero start nodes names the entry cycle.** `findEntryCycles` in
`cycles.ts` returns the cyclic SCCs no edge enters from outside — in a
zero-start-node graph every entry point is one of these, and one node
in each is where `start: true` belongs. The message lists the nodes
and both fixes.

**One function.** `startNodeIds(factory)` in
`src/factory/start-nodes.ts`, declaration order preserved. The loader
checks `length === 0`; the runner maps it onto its queue. In-memory
factories in tests bypass the loader, so the runner must use the same
rule rather than trust validation happened.

**`start` is a node-level topology field**, following `resume:`
(ADR 0035): optional, no schema default (so resolved-factory snapshots
do not change), passed through `inlineStepIntoNode`, and — because
`extends:` replaces nodes wholesale — carried or dropped with the
node. Rejected: a top-level `start: [ids]` list on the factory. It
would be a second place to look for a node's role and would not
compose under whole-node replacement.

**Nothing else moves.** Queue order, edge traversal, budgets,
terminal handling, `priorResults`, storage — untouched.

## Verification

- Unit: `start-nodes.test.ts` (no edges, on_success, on_failure-only,
  self-loop, closed cycle, `start: true`, `start: false`, order).
- Loader: no-start error names `a → b` and `start: true`; F6 shape
  loads with `a` the sole start; `p`/`v` loop fails bare and loads
  with `start: true`; self-loop; non-boolean `start` rejected.
- Runner: F6 probe orders `a b z` and `a b ask`; `start: true` on a
  node with a forward inbound edge dispatches at begin.
- Inlining: `start:` rides through `uses:`.
- `tsc`, biome, vitest, `openspec validate --all --strict`.
