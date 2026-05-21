---
tags: [concept]
aliases: [worktrees, git-worktree]
---

# Worktree

A worktree is the isolated git working tree minifac creates for each
[[Run]]. The factory operates inside the worktree, so the user's main
checkout stays clean and parallel runs don't collide.

## Location

`~/.minifac/worktrees/run-<change>-<slug>/` by default, where `<slug>`
is the first 6 hex chars of the [[Run]] id. Brief-less factory
invocations use `run-<factory>-<slug>` with the same shape.
Configurable globally via `~/.minifac/config.yaml` and per-repo via
`.minifac/config.yaml`. Lives outside the repo so it's machine-state
not repo-state — see [[0012-Where-State-Lives]].

## Branch

Created off `base_branch` from the [[Brief]] (default: caller's HEAD),
named `run/<change>-<slug>` (or `run/<factory>-<slug>` for brief-less
invocations). The slug is the same one in the worktree directory name,
so a reader can map between them at a glance.

The slug makes the branch per-run: two consecutive invocations of the
same change (e.g. after a failed run is retried) produce two distinct
branches and do not collide. See
[[0019-Run-Scoped-Branches]]. `minifac prune` deletes both the
directory and the branch it owns; `minifac merge <change>` ships the
branch into the default branch.

## Concurrency

A per-change-name lockfile at `~/.minifac/locks/<repo-hash>-<change>.lock`
contains the owning PID. Two runs against the same change name are
refused; runs against different change names run in parallel without
issue. Stale locks (dead PID) are reclaimed automatically. See
[[0009-Worktree-Default]].

## Cleanup

Hybrid policy (see [[0010-Worktree-Cleanup-Hybrid]]):

- Worktrees < 7 days old: always kept regardless of state
- ≥ 7 days AND branch merged to default branch: auto-pruned
- ≥ 7 days AND branch unmerged: kept (you might still want it)
- Failed runs: kept indefinitely (debug value)

Triggered manually via `minifac prune` (with `--all`, `--merged`,
`--older-than 30d`, `--failed` flags) and lazily at the start of
every `minifac run` invocation.

## Opt-out

`--in-place` on `minifac run`, or `mode: in-place` per-brief, runs the
factory in the caller's cwd instead of creating a worktree. For CI
environments or read-only factories.

## Related

- [[Run]] — what the worktree hosts
- [[Brief]] — declares `base_branch`
- [[Factory]] — operates inside the worktree
- [[0009-Worktree-Default]]
- [[0010-Worktree-Cleanup-Hybrid]]
- [[0012-Where-State-Lives]]
