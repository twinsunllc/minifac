---
tags: [concept]
aliases: [runs, factory-run]
---

# Run

A run is one invocation of a [[Factory]] against a [[Brief]] (for
brief-driven factories) or against a factory directly (for brief-less
ones). It's the atomic unit of work in minifac.

## Identity

Each run has a unique id (a UUID generated when the run is dispatched).
The first 6 hex chars of the id form the *run slug*, which is embedded
in the [[Worktree]] directory name (`run-<change>-<slug>`) and the
per-run branch name (`run/<change>-<slug>`). The lockfile name keeps
the older `<repo-hash>-<change>` shape — see
[[0019-Run-Scoped-Branches]] for why.

The branch name for any persisted run lives in the [[Runs-DB]] row as
`branch_name`. To find the branch for a given run, use
`minifac runs` (the table includes the branch) or
`minifac runs show <id>`. Rows from before this change carry
`branch_name = NULL`; their branches (if any still exist) were named
exactly after `change`.

## Anatomy

- A factory reference + a brief reference (when applicable)
- A [[Worktree]] (with a branch) where the work happens
- A stream of events (`stdout`, `stderr`, `status`) tagged by
  `nodeId` + `iteration` + `emittedAt`
- A structured result on completion: `status` (succeeded | failed),
  `reason` (terminal_node_succeeded | node_failed | budget_exhausted
  | graph_drained | unknown_executor), `proximateNodeId`, per-node
  execution log, total duration

## Persistence

All of the above lives in the [[Runs-DB]] — events as they happen,
result on completion. So the daemon viewer can show prior runs across
restarts, and (future) `auto-mode` can query "which briefs ran when."
See [[0011-SQLite-for-Runs]].

## Concurrency

One run per change name at a time, enforced by lockfile (see
[[0009-Worktree-Default]] and [[Worktree]]). Different change names
run in parallel without contention — runs share no resources except
[[Runs-DB]] (SQLite handles concurrent writers via WAL mode).

## Lifecycle of a typical run

1. `minifac run <brief>` invoked
2. Worktree created at
   `~/.minifac/worktrees/run-<change>-<slug>/`, with branch
   `run/<change>-<slug>` cut from `base_branch`
3. Lockfile claimed; runs.db row created with `status: running` and
   the per-run `branch_name` persisted
4. Runner walks the factory graph; events stream out as they arrive
5. Terminal node succeeds → run row updated to `succeeded`, lockfile
   released
6. Worktree (and branch) left intact for `minifac merge <change>` or
   manual review

## Related

- [[Factory]] — what the run executes
- [[Brief]] — what the run is for
- [[Worktree]] — where the run happens
- [[Runner]] — what executes the run
- [[Runs-DB]] — where the run persists
- [[Sentinel]] — how nodes signal their status
