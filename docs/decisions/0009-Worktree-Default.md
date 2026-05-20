---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0009: Worktrees by default; minifac owns the lifecycle

## Context

Factory runs make commits. Without isolation, they'd clobber the user's
in-progress work in the main checkout, or fight with each other if
multiple ran in parallel, or leave the working tree in unknown states
if they failed mid-run.

The team manually used `git worktree` during dogfood sessions to get
this isolation and it worked well. The friction was that *Claude Code*
was creating the worktrees — minifac itself didn't know about them.

## Decision

`minifac run` creates and manages [[Worktree]]s itself.

- Worktrees live at `~/.minifac/worktrees/<repo-hash>-<change>/` by
  default (configurable via global `~/.minifac/config.yaml` and
  per-repo `.minifac/config.yaml`)
- Branch is named after `change`; base defaults to `base_branch` from
  the [[Brief]] (falling back to caller's HEAD)
- All node `cwd`s default to the worktree path; per-node overrides
  remain available
- **Per-change-name lockfile** at
  `~/.minifac/locks/<repo-hash>-<change>.lock` holds the owning PID.
  Stale locks (dead PID) are reclaimed automatically.
- The factory's branch is left intact after the [[Run]] completes —
  the user reviews it like any contributor's branch and merges to main

`--in-place` flag (and `mode: in-place` per-brief override) opts out
of worktree creation, for CI environments or read-only factories.

## Consequences

- Main checkout stays clean during factory runs
- Multiple factory runs against different change names run in parallel
  without contention
- Two runs against the same change name are refused at lock-claim time
- Failed runs leave their worktree in place for debugging
- Worktrees accumulate; cleanup is a real concern (see
  [[0010-Worktree-Cleanup-Hybrid]])
- minifac now has a meaningful coupling to git — it shells out to
  `git worktree` and reads `git branch --merged`. Acceptable
  trade for the user-facing simplicity gain.

## Alternatives considered

- **In-place by default; opt into worktrees.** Rejected — the common
  case (run a factory; review its work) benefits from isolation; the
  CI / read-only case is the exception.
- **Per-repo `.minifac/worktrees/` instead of global
  `~/.minifac/worktrees/`.** Rejected — worktrees are machine-local
  state, not repo-state. Global keeps the repo clean. See
  [[0012-Where-State-Lives]].
- **User manages worktrees** (status quo before this decision).
  Rejected — friction; Claude Code / the user has to set up isolation
  every time. Minifac owning it is exactly the unlock.
- **`/tmp/minifac/worktrees/`.** Rejected — cross-platform
  inconsistency (macOS doesn't clear `/tmp` on reboot; Linux often
  does), and worktrees aren't actually throwaway — failed runs have
  debug value.

## Related

- [[Worktree]]
- [[Run]]
- [[Brief]]
- [[0010-Worktree-Cleanup-Hybrid]]
- [[0012-Where-State-Lives]]
