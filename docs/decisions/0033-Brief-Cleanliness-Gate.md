---
status: accepted
date: 2026-05-22
supersedes: []
superseded-by: null
tags: [decision]
---

# 0033: Brief cleanliness gate

## Context

`minifac autorun` polls `inputs/` and dispatches any brief whose
state computes to ready, with no regard for whether the brief file
itself is committed to git. Two failure modes follow:

1. **Untracked briefs.** A brief authored but not yet `git add`ed
   gets picked up the moment the operator saves it. Mid-edit dispatches
   are easy.
2. **Modified-but-uncommitted briefs.** A brief whose committed copy
   on `main` differs from the working-tree copy will get dispatched
   based on the working-tree content — but the **run worktree**
   (created at `~/.minifac/worktrees/run-<change>-<slug>/` from a
   git ref) sees the *committed* version. The operator and the
   spawned process disagree about the spec.

This second case is the more insidious one. The autorun scheduler
loads the brief from `inputs/<change>.md` on disk (working tree),
passes it through depends_on resolution and state computation, then
dispatches. The actual factory run checks out a ref into a worktree,
where the brief file may differ or be absent. Apply nodes that
substitute brief content via mustache see one thing; the operator
edited another. Silent divergence.

Briefs are first-class git-tracked artifacts per
[[0015-Brief-Deps-and-State]] — git is the source of truth for brief
doneness, dependency graphs, and history. Letting autorun fire on
non-committed files breaks that invariant for the input side.

The fix is a cleanliness gate: autorun skips uncommitted briefs
unconditionally; one-shot `minifac run` warns loudly but allows the
operator to proceed (with a `--require-clean` flag for strict use).

## Decision

### Definition of "unclean"

A brief is **unclean** when its `inputs/<change>.md` file is, against
the repo root's git index/HEAD, in any of:

- **Untracked** — never `git add`ed
- **Modified** — tracked but the working-tree copy differs from the
  index
- **Staged but uncommitted** — `git add`ed but not yet committed

Implementation uses `git status --porcelain -- <brief-path>`:
any non-empty output means unclean. The same helper that powers
`src/executor/check-merge.ts` and `src/cli/merge.ts`'s porcelain
parsing is reused — no new git wrapper.

The check is run against the repo root the autorun process is
watching (`--watch <dir>`'s parent, or `cwd` for the default
`<cwd>/inputs`). If the inputs directory is outside any git repo,
the check degrades to a no-op (skip the gate entirely) and a
one-time startup warning is emitted: `[autorun] inputs/ is not inside a git working tree; brief cleanliness gate disabled`.

### Autorun: skip with `unclean` reason

A new `SkipReason` value `unclean` joins the existing enum in
`src/cli/autorun-scheduler.ts`. The scheduler's `decide()` method
runs the cleanliness check after `in-flight` and `filtered` but
before the activity / state checks. If unclean, return
`{ action: "skip", reason: "unclean", brief, detail }` where `detail`
is the short status code (`??`, ` M`, `A `, etc.) so the operator
can tell at a glance what kind of unclean.

Logging mirrors other skip reasons:

**Raw mode:**
```
[autorun] skipped <change>: brief is uncommitted (??); commit or stash before autorun picks it up
```

**JSON mode:**
```json
{"kind":"skipped","ts":...,"change":"<change>","reason":"unclean","detail":"??"}
```

The skip is unconditional — no `--allow-unclean` flag. The
operator-side gesture for "I want to dogfood this brief now" is
either `minifac run <change>` (one-shot, warn-and-allow) or commit
the brief.

### One-shot `minifac run`: warn loudly + opt-in strict

`minifac run <change>` (one-shot, interactive) prints a prominent
warning when the brief is unclean but proceeds with the dispatch:

```
warning: brief inputs/<change>.md is uncommitted (??); the run
worktree will see the committed version, which may differ.
proceed anyway in 3s... (Ctrl-C to abort)
```

The 3-second pause is a deliberate "are you sure" friction without
requiring an interactive prompt (which would break non-TTY scripted
invocations). The pause is suppressed when stdin is not a TTY (CI,
piped invocations) — the warning still prints, but execution
continues immediately.

A new `--require-clean` flag converts the warning into a hard error:

```bash
minifac run my-change --require-clean
# error: brief inputs/my-change.md is uncommitted (??).
# commit it or drop --require-clean to proceed.
```

CI invocations and other strict-mode use cases pass `--require-clean`
to make the cleanliness check a gate.

### Why warn rather than refuse in one-shot mode

Briefs benefit from a "test before commit" loop: author the brief,
run it once, observe results, iterate, commit. Hard-refusing one-shot
runs on unclean briefs would force a worse loop (commit-then-fix
each iteration).

Autorun is different: it's unattended. The whole point of unattended
dispatch is that the operator isn't there to notice "oh, I left that
half-edited." The right default is to skip. The operator explicitly
opts back into "run anyway" by invoking `minifac run` directly.

### What's NOT checked

The gate looks **only at the brief file** itself, not the rest of
the working tree. A repo with unstaged changes elsewhere in `src/`
or `docs/` does not trigger the gate — only `inputs/<change>.md`
matters. This keeps the gate focused on its invariant (brief content
matches what the run worktree will see) without overreaching into
unrelated working-tree state.

`depends_on` ancestors of a brief are checked for the same
cleanliness rule. An ancestor brief that is unclean fails the gate
for any descendant that depends on it — silent divergence is just
as bad through transitive substitution as direct.

## Consequences

- **Predictable input contract.** Autorun only ever sees committed
  briefs. The brief file in the working tree, on `main`, and in
  the run worktree all agree.
- **Operator gets a clear signal.** The skipped log line names the
  brief and the unclean reason; recovery is one `git add && git commit`
  away.
- **One-shot mode stays ergonomic.** The warn-and-pause flow
  preserves the "iterate on a brief without committing each
  attempt" authoring loop.
- **CI gets a strict gate.** `--require-clean` turns the warning
  into an error for scripted use.
- **No persistent state.** The gate is a per-poll-cycle check; no
  caching, no new tables, no migration.
- **Degrades gracefully outside git.** Inputs outside a git
  working tree skip the gate with a startup warning, so non-git
  scratch use (rare but possible) isn't broken.

## Alternatives considered

- **Refuse unclean briefs in `minifac run` too.** Rejected — kills
  the dogfood-then-commit loop. `--require-clean` covers the strict
  case without forcing it on every operator.
- **Auto-commit the brief before dispatch.** Rejected — too much
  policy. Operators have varied commit conventions (squash, signed,
  conventional-commits) and forcing a minifac-generated commit
  would conflict with all of them. Commit gesture stays operator-owned.
- **Hash the brief content and compare to the committed copy each
  iteration.** Rejected — solves a slightly different problem
  (brief drift mid-run) that is already prevented by the worktree's
  ref-based checkout. The cleanliness gate's job is the
  pre-dispatch invariant, not mid-run drift.
- **Cleanliness check covers the whole working tree.** Rejected —
  overreach. A repo with WIP in unrelated areas should still be
  able to run committed briefs. Scope the gate to the brief file
  (and its ancestors).
- **Configurable per-brief opt-out via frontmatter.** Rejected for
  v1 — adds API surface for a use case no one has yet. If a brief
  legitimately benefits from "always allow unclean" semantics,
  revisit.

## Open questions

- Whether to extend the gate to **factory files** (`.minifac/factories/*.yaml`)
  as well — an unclean factory has the same worktree-divergence
  problem. Probably yes, but separate brief; this change scopes to
  briefs to keep the change small.
- Whether the 3-second pause should be configurable. Default 3s
  feels right; revisit if anyone complains.

## Related

- [[0015-Brief-Deps-and-State]] — git as source of truth for brief
  state; this ADR enforces the same invariant for autorun input
- [[0016-Auto-Mode]] — the autorun mechanism this gate hardens
- [[0031-Autorun-Failure-Backoff]] — sibling autorun-hardening
  decision; both add a `SkipReason` to the scheduler
