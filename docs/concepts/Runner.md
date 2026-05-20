---
tags: [concept]
aliases: [run-factory, graph-runner]
---

# Runner

The runner is the orchestrator that walks a [[Factory]]'s graph,
dispatches nodes to [[Executor]]s, streams events, enforces budgets,
and produces a structured [[Run]] result.

## Loop

1. Resolve start nodes (no `on_success` inbound) from the [[Factory]]
2. Build a `RunContext` for each scheduled node: factory reference,
   frozen snapshot of run-wide history, current `nodeId`, current
   `iteration` count, resolved `cwd`
3. Dispatch to the node's [[Executor]], consume its event stream
4. Append every event to the run-wide history (tagged with `nodeId`,
   `iteration`, `emittedAt`)
5. On node completion: evaluate outbound edges by `when` matching the
   node's final status, enforce `max_traversals`, enqueue successors
6. Repeat until: terminal node succeeds (run succeeds), node fails
   with no traversable recovery edge (run fails), or all budgets
   exhausted (run fails — budget-exhausted reason)

## Sentinel injection

The runner auto-appends the [[Sentinel]] instruction block to every
claude-executor prompt before sending. The [[Factory]] only carries
per-node success/failure *criteria*. See
[[0007-Sentinel-Runner-Injects]].

## History pass-through

Every event from every node is in the history, in emission order. A
node's second iteration in a [[Cycle]] sees its own prior outputs *and*
everything emitted in between. This is what makes propose → apply →
verify → propose loops actually iterative: the second propose sees the
first verify's failure.

## Persistence

The runner writes runs (and their events) to the [[Runs-DB]]. The
in-memory state is just for the current run; durable state lives in
SQLite. See [[0011-SQLite-for-Runs]].

## Two entry points share the runner

- `minifac run <brief>` — one-shot CLI invocation
- `minifac serve` — daemon that exposes runs over HTTP/SSE

Both call the same `runFactory(...)` with the same event consumer
shape. The daemon doesn't fork the runner; it's an additional consumer.

## Related

- [[Factory]] — what the runner walks
- [[Executor]] — what the runner dispatches to
- [[Run]] — what the runner produces
- [[Cycle]] — how the runner handles recovery
- [[Sentinel]] — how the runner classifies node outcomes
- [[Runs-DB]] — where runs persist
