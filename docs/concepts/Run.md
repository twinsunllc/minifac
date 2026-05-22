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

## Auto-merge in autorun

Under [[Auto-Mode]], the run lifecycle gains a wrapper-level step
between "factory succeeded" and "brief moves to `inputs/done/`":

1. Factory reaches a terminal-success node; the runs row is
   recorded as `succeeded` (the run-primitive contract is
   unchanged).
2. The autorun wrapper invokes the same merge primitive that backs
   `minifac merge` against the run's branch and the caller's
   configured default branch. The runner's built-in mark-done
   post-step is suppressed for this path so the wrapper can gate
   it on the merge outcome.
3. On merge success, the autorun wrapper invokes the mark-done
   helper against the caller's cwd so the brief in
   `inputs/<change>.md` moves to `inputs/done/<change>.md` on top
   of the just-merged default branch. Dependents become eligible
   on the next poll.
4. On merge failure, the autorun wrapper does NOT invoke mark-done.
   The brief stays at `inputs/<change>.md`, dependents stay
   blocked, the runs row stays `status = succeeded`, and the
   wrapper emits an `auto-merge-failed` event carrying the change
   slug, the run id, a short `reason` enum
   (`conflict`, `non-fast-forward`, `dirty-working-tree`,
   `no-default-branch`, `null-branch-name`, `other`), and an
   optional `detail`. The operator resolves manually (e.g.
   `minifac merge <change>` after rebasing or cleaning the tree).

The ordering invariant — factory success → merge → mark-done — is
the load-bearing contract. Under `--max-concurrent N > 1`, the
merge step is serialized by an in-process mutex so two concurrent
completions don't race against each other in the caller's repo.

Two flags govern this behavior:

- `--no-auto-merge` — opt out entirely. The merge step does not
  run, the runner's mark-done post-step is NOT suppressed (the
  brief moves on factory success as before this change), and no
  `auto-merge-failed` events fire. This is the documented escape
  hatch that restores the pre-auto-merge behavior.
- `--ff-only` — forbid the merge-commit fallback. A non-fast-
  forward merge becomes a merge failure mapped to
  `auto-merge-failed reason=non-fast-forward`.

Passing `--no-auto-merge` together with `--ff-only` is accepted
(not a usage error): the autorun process emits a single startup-
time stderr warning `--ff-only has no effect when --no-auto-merge
is supplied` and proceeds with `--no-auto-merge` winning.

Manual `minifac run` keeps its two-step flow: the runner marks the
brief done on success, and the operator runs `minifac merge` when
they want the branch on the default. Auto-merge is scoped to the
autorun wrapper, not the run primitive.

A factory that wires the `minifac:check-merge` step as a terminal
node (see [[check-merge-step]]) composes cleanly with autorun's
auto-merge: when the probe finds the merge would conflict, the
node fails, the factory is `failed`, and autorun's auto-merge step
does not fire (it only runs on factory success). So a check-merge-
guarded factory never produces an `auto-merge-failed` event — the
factory itself surfaces the bad merge.

## Output: TUI vs raw

When stdout is a TTY, `minifac run` defaults to an interactive TUI
(see [[Run-TUI]]). For pipes, redirects, and CI the same command
falls back to line-prefixed raw output. Two flags override the
auto-detection:

- `--raw` — force the raw line-prefixed output even in a TTY (useful
  inside `tmux` panes you intend to pipe).
- `--tui` — force the TUI even when stdout is not a TTY (used by
  snapshot tests).

Either way, the final `[run] <status> cwd=<path>` summary is
written to stderr on completion.

## Related

- [[Factory]] — what the run executes
- [[Brief]] — what the run is for
- [[Worktree]] — where the run happens
- [[Runner]] — what executes the run
- [[Runs-DB]] — where the run persists
- [[Run-TUI]] — the interactive surface
- [[Sentinel]] — how nodes signal their status
- [[Outputs]] — declared deliverables produced by run nodes (run-scoped
  directory at `~/.minifac/outputs/<run-id>/<node-id>/<iteration>/`)
