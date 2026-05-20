---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0012: Where state lives — machine vs repo split

## Context

minifac creates and reads several kinds of persistent state: factory
definitions, briefs, worktrees, locks, run history, config. They have
different lifecycles and different audiences. Conflating them in one
place would be wrong; scattering them without intent would also be
wrong.

## Decision

Two homes, by intent:

**`~/.minifac/` — machine-state. Per-user, not in git.**

- `~/.minifac/worktrees/<repo-hash>-<change>/` — per-run worktrees
- `~/.minifac/locks/<repo-hash>-<change>.lock` — concurrency control
- `~/.minifac/runs.db` — SQLite run history
- `~/.minifac/config.yaml` — global user preferences (default
  worktree dir, default model, etc.)
- Future: cached factory templates, transient artifacts

**`.minifac/` in the target repo — repo-state. In git.**

- `.minifac/factories/<name>.yaml` — per-repo custom factory
  definitions (with `extends:` to built-ins where appropriate)
- `.minifac/config.yaml` (optional) — repo-level overrides
  (`inputs_dir`, `worktrees_dir`, etc.)

**`inputs/` in the target repo — also repo-state, also in git.**

- Per-change [[Brief]] markdown files

## Consequences

- A repo's `.minifac/` directory is a small, reviewable set of files
  that travel with the code
- The user's machine accumulates per-run state in `~/.minifac/`
  without bloating any repo
- Machine state can be wiped (`rm -rf ~/.minifac/worktrees/`) without
  losing any repo-level configuration
- Repos can share factory customizations by committing
  `.minifac/factories/*.yaml` — collaborators inherit them on clone
- Worktrees in `~/.minifac/` are git-tracked by the *source* repo via
  `git worktree`'s metadata (`.git/worktrees/`), even though the
  worktree directory lives outside the repo

## Alternatives considered

- **Everything in `.minifac/` inside the repo** (including worktrees
  and runs.db). Rejected — bloats the repo's working tree with
  machine-specific data; worktrees and run history shouldn't be in
  git.
- **Everything in `~/.minifac/`** (including factory definitions).
  Rejected — factory customizations are project knowledge; they
  belong with the code so collaborators get them on clone.
- **`/tmp` for worktrees, `~` for everything else.** Rejected — /tmp
  has cross-platform lifecycle issues (see [[0009-Worktree-Default]]).
- **A single configurable root.** Rejected — they're different
  things with different audiences; one root doesn't capture that.

## Related

- [[Worktree]]
- [[Runs-DB]]
- [[Brief]]
- [[0009-Worktree-Default]]
- [[0011-SQLite-for-Runs]]
