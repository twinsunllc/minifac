---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0010: Hybrid worktree cleanup policy

## Context

Once minifac owns [[Worktree]] lifecycle (see [[0009-Worktree-Default]]),
worktrees accumulate. Each is a full working tree (potentially tens to
hundreds of MB for large repos). Without cleanup, `~/.minifac/worktrees/`
bloats indefinitely. Without retention, the user loses debug value and
unmerged work.

## Decision

Hybrid policy that captures the obvious-junk case automatically while
protecting unmerged work and recent runs:

- **Worktrees < 7 days old**: always kept regardless of state
- **≥ 7 days AND branch is merged** to default branch: auto-pruned
- **≥ 7 days AND branch is unmerged**: kept (might still be in flight)
- **Failed runs**: kept indefinitely (debug value)

"Merged" detection uses both `git branch --merged <default>` and a
fallback `git rev-list` check for squash-merges (where the original
commit hashes don't survive). Both checks are cheap.

**Triggers:** manual (`minifac prune` with `--all`, `--merged`,
`--older-than 30d`, `--failed` flags) plus lazy-on-invocation (a
cheap prunables check at the start of every `minifac run`). No daemon
dependency.

## Consequences

- The "I forgot about it, it's done, free up the space" case is
  handled automatically
- Unmerged work is never auto-deleted; user discretion required
- Failed runs persist for as long as the user wants to inspect them
- Worktree dir can be repointed via config if `~/` is space-constrained
- `minifac prune` is a documented, explicit cleanup primitive — users
  who want manual-only control just never invoke it
- Branch detection happens against the main checkout's default
  branch reference; if that's stale, the auto-prune might miss some
  merged branches (false negative; safe failure mode)

## Alternatives considered

- **Aggressive: auto-prune after N days regardless of state.**
  Rejected — risks deleting unmerged work; the cost is silent data
  loss.
- **Conservative: never auto-prune.** Rejected — accumulates forever;
  the user has to remember to clean up.
- **Time-only.** Rejected — same risk as aggressive.
- **On every successful run, auto-prune that run's worktree if its
  branch was merged.** Rejected — too eager; "merged" status often
  isn't true until after the user does the merge separately.
- **Daemon-scheduled cleanup** (cron-like inside `minifac serve`).
  Rejected for v0 — would require the daemon to be running, which
  isn't a v0 requirement. Lazy-on-invocation captures the same effect.

## Related

- [[Worktree]]
- [[0009-Worktree-Default]]
