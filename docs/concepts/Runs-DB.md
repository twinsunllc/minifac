---
tags: [concept]
aliases: [runs-db, runs.db, run-history]
---

# Runs DB

Persistent storage for [[Run]] history. SQLite file at
`~/.minifac/runs.db` (configurable). Survives daemon restarts; lets
the viewer show prior runs; designed to extend for brief state when
[[Auto-Mode]] earns its way in.

## Storage choice

SQLite, not Dolt, not beads. SQL queries cover the realistic uses
("show me all failed verify nodes this month"); WAL mode handles
concurrent writers across processes; one file, no daemon. See
[[0011-SQLite-for-Runs]].

## Location

`~/.minifac/runs.db` — global, machine-local, alongside worktrees
and locks. Run history is per-machine and append-only; doesn't
belong in git. See [[0012-Where-State-Lives]].

## Schema (sketch)

- **runs**: id, factory, brief_path, change, status, reason,
  proximate_node_id, started_at, ended_at, base_branch, worktree_path
- **events**: run_id, seq, node_id, iteration, kind, payload,
  emitted_at
- **node_executions**: run_id, node_id, iteration, status, started_at,
  ended_at, exit_code, sentinel_status

Exact schema lives in the implementation (the
`run-history-persistence` proposal). Treat the above as an indication
of intent.

## Future-proofing

The schema deliberately has room for brief state — `ready`,
`in-progress`, `blocked-on-deps`, `done` — so the `brief-deps-and-state`
change can extend `runs.db` rather than introduce a new store. The
[[Brief]] file remains the *intent*; the [[Runs-DB]] holds the
*runtime state*.

## Access

- The [[Runner]] writes runs + events as they happen
- The daemon viewer reads from here for prior-run replay
- Future: a `minifac runs` CLI command for ad-hoc query / listing
- Future: `auto-mode` queries "which briefs are ready to claim"

## Pluggability

The storage interface is pluggable. SQLite is the only shipped adapter.
A [[Dolt]] adapter is deferred (git-versioning isn't actually useful
for append-only machine-generated data). A [[Beads]] adapter could
slot in if richer state semantics earn their way.

## Related

- [[Run]] — what's stored here
- [[Runner]] — what writes here
- [[Worktree]] — sibling concept in `~/.minifac/`
- [[0011-SQLite-for-Runs]]
- [[0012-Where-State-Lives]]
