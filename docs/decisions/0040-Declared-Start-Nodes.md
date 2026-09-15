---
status: accepted
date: 2026-09-15
supersedes: []
superseded-by: null
tags: [decision]
---

# 0040: Start nodes are nodes with no inbound edge; `start: true` opts in

## Context

The [[Runner]] begins a run by dispatching every *start node*. Until
now a start node was "a node with no `on_success` inbound edge". The
rule came from the propose/verify loop in
[[0002-Cycles-First-Class]]: `verify → propose` on failure is recovery
flow, so it should not stop `propose` from being the entry.

The rule has a second consequence that was never intended. Any node
whose *only* inbound edges are `on_failure` — an escalation node, a
human-wait node, a re-poll node — is also a start node, and runs at
begin. scarif-factory's FINDINGS F6 probed it (issue #36): `a → b`,
`b → ask` (`on_failure`), `b → z`. The run order was `a ask`. `ask`
ran before `b` ever failed and, being terminal, ended the run. F6's
conclusion: "no escalation node can exist in any factory graph" —
every `on_failure` target must also have an `on_success` inbound edge
to avoid auto-starting, which is a topological accident nobody
designing a recovery path would think to check. F31 (issue #34)
tripped the same wire from the other side: an unwired typo node
became a start node.

Two proposals were on the table: infer start nodes from reachability
over all edge kinds, or declare them. Pure inference cannot handle the
one legitimate case the old rule was written for — an entry node that
sits inside a cycle has an inbound edge by definition, and no
edge-kind rule distinguishes "the loop's entry" from "the loop's
escalation target". Both are `on_failure` targets. The graph alone
does not carry that fact; the author does.

## Decision

**A start node is a node with no inbound edge from another node, of
any kind, or a node declaring `start: true`.**

- Every edge kind counts as inbound: `on_success`, `on_failure`, and
  whatever kinds are added later. An `on_failure`-only target is not a
  start node.
- A **self-loop is not an inbound edge** for this purpose. `a → a`
  cannot make `a` reachable from anywhere else, so a node whose only
  inbound edge is its own retry loop still starts. Without this
  carve-out the shipped bounded-retry idiom (`a → a` on failure,
  `a → t` on success) would have zero start nodes.
- `start: true` is a node-level boolean, optional, no default. It
  declares the node a start node regardless of inbound edges. It is
  graph topology, not step behavior: it sits beside `terminal`,
  `max_iterations` and `resume`, is preserved through step inlining,
  and is replaced wholesale with the node under `extends:` (ADR 0008).
  `start: false` is the same as omitting it. Declaring it on a node
  that has no inbound edges is redundant and allowed.
- **Zero start nodes is a load error naming the entry cycle.** When
  every node has an inbound edge the graph can only be entered through
  a cycle no edge enters from outside; the error names that cycle's
  nodes and the fix (`start: true` on the entry, or remove the edge).
- One function, `startNodeIds` in `src/factory/start-nodes.ts`, is
  the rule. The loader validates with it and the runner seeds its
  queue with it; the two computations that used to be duplicated (and
  could have drifted) are gone.
- No other dispatch semantics change. Queue order, edge traversal,
  budgets, terminal handling and `priorResults` are untouched.

## Consequences

- An escalation / wait / re-poll node can now exist: it is reached
  only when its `on_failure` edge fires. The F6 probe orders `a b z`,
  or `a b ask` when `b` fails.
- **Breaking for one graph shape**: a cycle whose entry node has a
  back-edge into it (`p → v`, `v → p` on failure) no longer loads
  without `start: true` on `p`. The error says exactly that. The
  shipped examples are unaffected — `sdd.yaml`'s `verify → apply`
  recovery edge lands on `apply`, which `propose → apply` already
  reaches, and `propose` has no inbound edge. Five in-repo test
  fixtures were the only casualties; each gained one line.
- The old spec sentence "a node whose only inbound edges are
  `on_failure` is still an entry point" is reversed. The graph-runner
  spec's "Start nodes" requirement is rewritten in this change.
- A node with `start: true` *and* a forward inbound edge dispatches
  twice on a linear path (once at begin, once when its predecessor
  succeeds). That is the declared meaning, not a defect; it is the
  same double-dispatch a fan-in already produces (F5).

## Alternatives considered

- **Keep inference, extend it to reachability** ("start nodes are the
  nodes nothing reaches"). Rejected: identical to the chosen inference
  half, but with no escape hatch a cycle's entry is unreachable-by-
  definition and the graph has no start. Declaring the entry is the
  only honest signal.
- **Declaration only** (`start: true` required on every start node).
  Rejected: every existing factory, including `hello.yaml`, would
  break for no gain; the no-inbound case is unambiguous and the
  inference is one line.
- **Infer from `on_success` inbound, but exclude nodes whose outbound
  edges are empty / who are terminal.** Rejected: F6's `ask` is
  terminal, but a non-terminal escalation node (`ask → plan`) is just
  as wrong to auto-start. Heuristics on node shape guess at intent.
- **Count self-loops as inbound.** Rejected: strictly reads "any
  inbound edge", but turns every bounded self-retry into a
  zero-start-node error that `start: true` then has to paper over. A
  self-loop provides no entry; treating it as one is a false
  positive.
- **Warn instead of error on zero start nodes.** Rejected: a run with
  an empty queue finishes immediately with no node executed. That is a
  load-time fact and should fail at load time, as the terminal-node
  rule already does.

## Related

- [[Factory]], [[Runner]], [[Cycle]]
- [[0002-Cycles-First-Class]] — where the `on_success`-only rule came
  from
- [[0008-File-Per-Factory-Composition]] — whole-node replacement under
  `extends:`, which `start:` follows
- [[0035-Cross-Node-Session-Resume]] — `resume:` set the precedent for
  a node-level topology field that rides through step inlining
- Issue #36; scarif-factory FINDINGS F6 (and F31 / issue #34, the
  unwired-node face of the same wire)
