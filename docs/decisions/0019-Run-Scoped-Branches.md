---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0019: Run-scoped branch naming and a minifac-managed merge verb

## Context

Today the [[Worktree]] for a [[Run]] is on a branch named exactly
`<change>`. Two consequences fall out:

1. **Retries collide.** A failed run leaves the `<change>` branch
   behind. `minifac prune` removes the worktree directory + git
   metadata but not the branch ref, so the next `minifac run
   <change>` fails with `fatal: a branch named X already exists`.
   This is real and the user just hit it.
2. **Each brief gets at most one runnable branch at a time.** No
   natural way to keep multiple attempts as inspectable artifacts —
   comparing two runs of the same brief (different factories,
   different models, factory iteration) requires manual checkpointing.

A naming convention of `run/<change>-<slug>` per run, where slug is
derived from the run UUID, solves both. Branches become run-scoped:
each invocation creates a unique branch, retries don't collide,
multiple attempts coexist as diffable artifacts. The orphan-branch
Open-Question dissolves by construction.

The flip side is that "ship a successful run" — previously implicit
in `git merge <change>` — needs a small affordance: which run to
merge, and from where. A `minifac merge` verb covers the common case.

## Decision

### Branch naming

Each [[Run]] gets a branch named `run/<change>-<slug>`, where
`<slug>` is the first 6 hex characters of the run's UUID. Examples:
`run/brief-deps-and-state-a7b3c1`, `run/foo-c91d2f`.

For brief-less factory invocations (factories declaring
`brief: none`), the change-name slot is filled with the factory
name: `run/<factory>-<slug>`. Same structural shape.

### Worktree directory naming

`~/.minifac/worktrees/run-<change>-<slug>/` — mirrors the branch name
with `-` instead of `/` for filesystem flatness. Configurable per
[[0009-Worktree-Default]] (the parent directory remains the only
configurable bit; the run-scoped child name is fixed).

### Lockfile scope (unchanged for now)

Lockfile stays keyed on `(repo-hash, change)` for v0. Two `minifac
run <same-change>` invocations on the same machine still serialize.
Concurrent runs across *different* changes proceed in parallel as
they do today.

A future change ([[0020-Factory-Override-At-Invocation]]) widens
the lockfile scope to `(repo-hash, change, factory)` so A/B
comparisons against the same brief can run concurrently. That's
explicitly *not* this change.

### Runs.db: new `branch_name` column

[[Runs-DB]] gains a `branch_name TEXT` column on the `runs` table.
Migration ships as `0002_add_branch_name.sql` per the existing
migration system from [[0011-SQLite-for-Runs]]. The runner
populates this column when creating the worktree — the value is
the full branch name (`run/<change>-<slug>`).

`minifac runs` output and the viewer's recent-runs panel both surface
the branch name so users can see "merge this with `git merge <branch>`"
at a glance.

### `minifac merge` verb

```
minifac merge <change>                 # latest succeeded run for change
minifac merge <run-id>                 # specific run by id (or prefix)
minifac merge <change> --pick          # interactive: show runs, pick one
minifac merge <change> --ff-only       # refuse merge commits (default: try ff, fall back to merge commit)
```

Behavior:

- Resolve the target branch from `branch_name` in runs.db
- `git fetch` / `git checkout` to the default branch (or whatever
  the current branch is, if not on default)
- `git merge --ff-only` first; if that fails and `--ff-only` not
  requested, fall back to a merge commit
- On conflict, abort the merge and surface a clear error pointing
  at the conflicting paths
- Refuses if the run's `status` isn't `succeeded` (use `--force`
  to override; rarely correct)

The merge does NOT auto-delete the run's branch after merging. The
prune flow eventually cleans up merged-old branches per
[[0010-Worktree-Cleanup-Hybrid]].

### Prune cleans up branches owned by minifac

`minifac prune` already removes worktree directories + git
worktree metadata; it gains the small additional step of deleting
the branch ref for any worktree it pruned. Resolves the orphan-
branch Open-Question entry by construction.

(With run-scoped naming, retries don't collide regardless — but
cleaning up the branch on prune is still the right behavior so
old branches don't accumulate forever.)

## Consequences

- Retry-after-failure works without manual branch deletion. The
  orphan-branch bug is gone.
- Multiple attempts of the same brief coexist as named, diffable
  branches in git. `git diff run/foo-a7b3 run/foo-c91d` is a real
  comparison.
- `minifac runs --change foo` shows all attempts with their branch
  names; the user picks which to merge.
- "Ship this run" becomes a documented verb (`minifac merge`)
  rather than implicit knowledge.
- Branch namespace grows over time; prune handles cleanup.
- The factory's archive node still does `git add -A && git
  commit` — it lands on whatever branch the worktree is on,
  which is `run/<change>-<slug>` now instead of `<change>`. No
  factory changes needed.
- Brief authoring docs and READMEs that mentioned the
  `<change>` branch by name need a small refresh.

## Alternatives considered

- **Keep `<change>` naming; require `minifac prune --branches`
  to clean up.** Rejected — the bug recurs anytime the user
  forgets to prune; "minifac forgot to clean up after itself" is
  the wrong default.
- **Timestamp-based slug** (`<change>-2026-05-21-1234`). Rejected
  — uglier, sub-second collisions possible, doesn't tie back to
  runs.db cleanly.
- **Sequential slug** (`<change>.1`, `.2`, …). Rejected —
  requires tracking state outside the run id; collisions across
  machines.
- **Encode factory name in the branch** (`run/<change>-<factory>-<slug>`).
  Rejected for v0 — slug is unique per run regardless; runs.db
  carries the factory; branch name doesn't need the extra
  segment. Revisitable if multi-factory comparison gets common
  enough that scanning branch names by factory becomes useful.
- **Use slash-separated namespace** (`run/foo/a7b3`). Rejected —
  works with git but trips up some shell completion and looks
  hierarchical when it's actually flat.

## Related

- [[Worktree]] — naming convention updated
- [[Run]] — branch is now per-run identity, not per-change
- [[Runs-DB]] — gains `branch_name` column via `0002_*.sql`
- [[0009-Worktree-Default]] — parent worktree dir unchanged
- [[0010-Worktree-Cleanup-Hybrid]] — prune cleans up branches
  it owns
- [[0011-SQLite-for-Runs]] — migration system this extends
- [[0015-Brief-Deps-and-State]] — consumer of `branch_name`
- [[0020-Factory-Override-At-Invocation]] — sibling proposal;
  widens lockfile scope
- [[Open-Questions]] — removes "Prune leaves orphaned branches
  behind"
