---
tags: [concept]
aliases: [run-factory, graph-runner]
---

# Runner

The runner is the orchestrator that walks a [[Factory]]'s graph,
dispatches nodes to [[Executor]]s, streams events, enforces budgets,
and produces a structured [[Run]] result.

## Loop

1. Resolve start nodes from the [[Factory]]: no inbound edge from
   another node (any `when`; self-loops don't count), or `start: true`
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
(`{ nodeId, iteration, status, reason, startedAt, endedAt, outputs,
nudges_used, session_id }`). The
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

## Cross-node session resume

The runner captures the session id each dispatch announces (the
stream-json `system` / `init` line) and records it on the dispatch's
prior-results entry and in the [[Runs-DB]]. The CLI emits that line
**once per turn**, not once per process, so a nudged dispatch
announces several times — the runner keeps the last one.

When a node declares `resume: <node-id>` (see [[Factory#Cross-node
session resume]]), the runner resolves the session captured for the
**latest completed dispatch of the named node** — the same
latest-per-node rule prior-results addressing already uses — and hands
it to the [[Executor]]. Consequences worth internalizing:

- **A later iteration follows the target's newest session.** If the
  target re-runs (a cycle back to `plan`), the resuming node's next
  iteration continues the *new* conversation. That's what makes
  "re-plan, then re-apply" behave the way an operator expects.
- **A resumed session is a pointer, not a snapshot.** Resumed turns
  append to the same conversation, so a node that resumes twice sees
  its own earlier turns the second time around. Usually desirable in a
  revise loop; it does mean context grows every pass. The CLI has a
  fork option, but v1 deliberately appends — see [[Open-Questions]].
- **The target's status doesn't matter, only its session.** A recovery
  node on an `on_failure` edge can continue a failed node's
  conversation, which is exactly the useful case.

If the resume cannot be satisfied, the runner fails the node **before
spawning anything** — it never quietly starts a fresh session, because
a context-free cheap model produces confident, wrong output that looks
like success. Three reasons, all ordinary node failures (so
`on_failure` edges still fire):

| Reason | When |
|---|---|
| `resume_unavailable` (`no_prior_dispatch`) | the target hasn't run in this run |
| `resume_unavailable` (`no_session_captured`) | the target ran but announced no session (crash, rate-limit, abort) |
| `resume_unsupported` | the node's executor declares `supportsResume: false` |

A session that resolves but turns out to be unreadable is *not* one of
these: the child exits non-zero and the ordinary exit-code path
applies. The runner never inspects the CLI's session storage.

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
