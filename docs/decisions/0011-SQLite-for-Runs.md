---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0011: SQLite for run history; defer Dolt and beads

## Context

Run state evaporates when the daemon dies. This has concrete costs:
the viewer can't show prior runs across restarts, you can't query
"what happened with change X three days ago," and `auto-mode` (when
it earns its way in) needs persistent state to function.

An earlier v0 slicing bundled "beads + Dolt" as one storage change,
on the framing "beads for work items, Dolt for run history." After
actually using the system, it became clear those are two unrelated
problems and only one of them is urgent.

## Decision

Persistent run history lives in **SQLite at `~/.minifac/runs.db`**.
Configurable, but global by default — runs are machine-local,
append-only, don't belong in git.

Schema covers runs, events, per-node executions. Designed with room
to extend for *brief state* (`ready`, `in-progress`, `blocked`,
`done`) when [[Auto-Mode]] earns its way in — the same DB grows new
tables; no second store needed.

The storage layer is pluggable. SQLite is the only shipped adapter
in v0. Dolt and other adapters are slots, not v0 work.

[[Beads]] is **deferred** as a separate question — it solves the
*backlog* problem (state machine, dependencies, comments on briefs),
not the *run history* problem. Today's `inputs/` directory + naming
convention is sufficient until backlog gets unwieldy.

## Consequences

- Daemon viewer can show prior runs across restarts
- Cross-run queries become trivial (SQL: "all failed verify nodes
  this month," etc.)
- Concurrent writers handled by SQLite WAL mode — multiple CLI runs
  and the daemon can write without coordination
- One file, no daemon required, no extra install
- Future state extensions (brief state, dependencies) extend this
  store rather than introducing a new one — simpler ops, one source
  of truth
- Run history is per-machine — it doesn't sync to other machines.
  If that matters later, a sync mechanism or Dolt adapter slots in.

## Alternatives considered

- **Dolt for run history.** Rejected — git-versioning is genuinely
  not useful for append-only machine-generated data. The earlier
  "Dolt for run history" framing was driven by "Dolt sounds cool"
  more than concrete need.
- **JSON files in `~/.minifac/runs/<run-id>/`.** Rejected — works
  for storage but painful for queries. The first time you want
  "show me last week's failures" you'd want SQL anyway.
- **Beads for run history.** Rejected — wrong tool. Beads is for
  issue / work-item tracking, not for event streams.
- **In-memory only (status quo before this decision).** Rejected —
  the loss-on-restart cost is too high once you have multiple
  changes running through.

## Related

- [[Run]]
- [[Runs-DB]]
- [[0012-Where-State-Lives]]
- [[Open-Questions]] — beads-integration, dolt-adapter, brief-deps-and-state
