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

## Prior-results pass-through

Each scheduled node receives a frozen snapshot of `priorResults` —
a structured array with one entry per completed node execution
(`{ nodeId, iteration, status, reason, startedAt, endedAt }`). The
`reason` field carries the [[Sentinel]] REASON line on failure
(otherwise `null`), so a node's second iteration in a [[Cycle]]
sees *what completed* and *why anything failed* without paying to
pull every prior event into its prompt. The second propose sees the
first verify's REASON; that's what makes propose → apply → verify →
propose loops iterative.

Raw events still stream to `onEvent` consumers (CLI, viewer) in
real time and persist to the [[Runs-DB]] — they're just no longer
pushed into per-node prompts. If a future node type needs raw
events, it queries [[Runs-DB]] directly. See
[[0014-Structured-Prior-Results]].

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
