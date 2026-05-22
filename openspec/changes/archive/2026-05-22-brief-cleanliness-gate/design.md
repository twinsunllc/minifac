# Design — brief-cleanliness-gate

## Context

`minifac autorun` is a poll loop over `inputs/<change>.md`. The
scheduler loads the working-tree copy of each brief, computes its
state, and dispatches a factory run. The factory run executes inside
a fresh git worktree created from a ref — typically the head of the
branch containing the committed brief. If the brief is untracked or
locally modified, the working-tree text and the worktree text diverge.
Apply nodes that mustache-substitute brief content see one thing; the
operator who saved the file sees another.

The full rationale, alternatives, and rejected options are in
`docs/decisions/0033-Brief-Cleanliness-Gate.md`. This design doc
covers the implementation shape that follows from that decision.

## Goals / Non-Goals

**Goals:**

- Stop autorun from dispatching uncommitted briefs, with a clear
  log line naming the recovery gesture.
- Preserve the one-shot `minifac run` dogfood-before-commit loop,
  with a loud warning + short pause as the only behavioral
  change.
- Offer `--require-clean` so CI / strict invocations can opt into
  the hard-fail behavior.
- Honor `depends_on` recursively: an unclean ancestor poisons all
  descendants.
- Degrade gracefully outside a git working tree (no-op + one-time
  startup warning).

**Non-Goals:**

- Factory-file cleanliness (`.minifac/factories/*.yaml`) — same
  problem, separate change.
- Auto-committing the brief on the operator's behalf.
- Hashing brief content to detect mid-run drift (a different
  invariant; not protected here).
- Whole-working-tree cleanliness check (would be overzealous and
  fight the authoring loop).
- Per-brief frontmatter opt-out.
- Making the 3s pause configurable.

## Decisions

### Decision 1: Cleanliness probe shape

Expose a single function in `src/brief/cleanliness.ts`:

```ts
export type CleanlinessResult =
  | { status: "clean" }
  | { status: "unclean"; code: string }
  | { status: "disabled"; reason: "not-a-git-repo" };

export async function checkBriefCleanliness(
  briefPath: string,
  repoRoot: string,
): Promise<CleanlinessResult>;
```

Implementation calls `git -C <repoRoot> status --porcelain -- <briefPath>`.
Non-empty output → `unclean` with the first line's two-char status
code. Empty output → `clean`. A "not a git repository" failure →
`disabled`.

**Rationale:** `git status --porcelain` is the canonical source of
truth for working-tree vs index vs HEAD divergence. Parsing the
porcelain code (`??`, ` M`, `A `, etc.) gives operators a precise
signal in the skip log without us having to invent our own
vocabulary.

**Alternatives rejected:**

- Comparing file mtime to HEAD commit time. Doesn't catch
  add/remove and is unreliable across filesystems.
- Hashing the working-tree file vs `git show HEAD:<path>`. More
  expensive, doesn't catch untracked, and reinvents what
  porcelain already gives us.

### Decision 2: Reuse existing `runGit` helper

The merge subcommand already exec-wraps `git` in
`src/executor/check-merge.ts` and `src/cli/merge.ts`. The
cleanliness probe reuses that helper rather than spawning a new
subprocess abstraction.

**Rationale:** one git-subprocess pattern in the codebase. Don't
introduce a second.

### Decision 3: Recursive ancestor walk

A sibling helper walks the brief's `depends_on` graph:

```ts
export async function checkBriefAndAncestorsCleanliness(
  rootBrief: Brief,
  opts: {
    inputsDir: string;
    repoRoot: string;
    loadBrief: (change: string) => Promise<Brief>;
  },
): Promise<
  | { status: "clean" | "disabled" }
  | { status: "unclean"; offending: string; code: string }
>;
```

It performs a depth-first traversal of `depends_on`, returning the
*first* unclean brief encountered (topologically nearest the root
first — i.e., the root brief itself is checked before any of its
ancestors). Sentinel deps that don't resolve to a real file are
ignored. A cycle bubbles up as `BriefCycleError`, which the
scheduler already converts to the `blocked` skip reason via the
existing state machine path.

**Rationale:** an unclean ancestor disagrees with HEAD just as
much as an unclean leaf would. The state machine treats `depends_on`
as load-bearing, so the cleanliness gate must too.

**Alternatives rejected:**

- Check only the root brief. Would let a `done`-but-uncommitted
  ancestor poison a descendant's dispatch.
- Check every brief in `inputs/` proactively. Wasted IO on briefs
  the operator isn't trying to schedule.

### Decision 4: Where to slot the check in `decide()`

The cleanliness check runs **after** `in-flight` and `filtered`
short-circuits and **before** `computeBriefState`. Both short-circuits
are local to the scheduler's in-memory state and don't depend on the
brief's content; running them first preserves their precedence (the
operator who set `--filter` doesn't need an unclean-warning storm).

Conversely, `computeBriefState` reads the working-tree brief and
its ancestors to determine `doneness` / `depends_on` satisfaction.
That state computation is meaningless when the input is in flux —
the scheduler shouldn't even try.

### Decision 5: SkipReason value and log shape

A new value `unclean` joins the existing `SkipReason` union. The
scheduler's `skipped` event carries:

- `reason: "unclean"`
- `detail: "<code>"` when the root brief itself is unclean
- `detail: "<offending-change> (<code>)"` when an ancestor is the
  offender

The raw-mode log lines:

```
[autorun] skipped <change>: brief is uncommitted (<code>); commit or stash before autorun picks it up
[autorun] skipped <change>: ancestor brief <offending> is uncommitted (<code>); commit or stash before autorun picks it up
```

The JSON-mode line carries `reason: "unclean"` and the `detail`
field exactly as above.

### Decision 6: One-shot `minifac run` behavior

The `run` subcommand action handler invokes
`checkBriefAndAncestorsCleanliness` after brief resolution but
before lockfile claim / worktree creation. Three outcomes:

1. **Clean** → unchanged behavior.
2. **Unclean** + `--require-clean` → stderr error,
   `process.exitCode = 1`, no lock, no worktree, no run.
3. **Unclean** without `--require-clean` → stderr warning, then
   `await setTimeout(3000)` if `process.stdin.isTTY` is truthy
   (the pause is suppressed on non-TTY so CI / piped invocations
   are not slowed down), then proceed.
4. **Disabled** → no warning, no pause, dispatch.

The pause uses `node:timers/promises`'s `setTimeout`, awaited in
the request path. Ctrl-C during the pause aborts via Node's
default SIGINT handling (the process hasn't claimed any
resources yet).

### Decision 7: `--require-clean` flag

Added to the `run` subcommand only. Not added to `autorun`
(autorun's behavior is unconditional — the flag would be a no-op
or a footgun). Documented in `--help` and `docs/CLI.md`.

### Decision 8: One-time startup warning

When the scheduler starts, it probes for git-repo-ness once
(either via the first cleanliness call's `disabled` return or via
`git rev-parse --is-inside-work-tree`). If disabled, the scheduler
emits exactly one warning to its log:

```
[autorun] inputs/ is not inside a git working tree; brief cleanliness gate disabled
```

This is a startup warning, not a per-poll warning. The
implementation tracks a `disabledWarned` boolean on the scheduler
instance.

## Risks / Trade-offs

- **[Risk] Subprocess cost on large `depends_on` chains** → The
  probe is `git status --porcelain -- <path>` per brief, which is
  O(few-ms). Even chains of 10 ancestors are cheap. If the chain
  ever grows into the hundreds, we'd batch multiple paths into a
  single porcelain call. Not a v1 problem.

- **[Risk] Operator confusion at the 3s pause** → The warning
  text explicitly says "the run worktree will see the committed
  version, which may differ" and "proceed anyway in 3s... (Ctrl-C
  to abort)". That copy is load-bearing; revising it should go
  through the spec.

- **[Risk] Race between the probe and the dispatch** → The
  operator could commit between the probe (clean) and the
  worktree creation. That's fine; the worktree still gets the
  newly-committed copy. The reverse race (clean → unclean) is
  what the gate exists to catch; even if it slips through one
  poll cycle, the next cycle re-evaluates.

- **[Trade-off] No bypass flag for autorun** → Operators who want
  to dispatch an in-flux brief use `minifac run` instead. This
  matches the decision doc; a `--allow-unclean` flag would be the
  obvious next escape hatch, and we deliberately don't ship one.

## Migration Plan

This is an additive behavior change. No data migration. Existing
clean-brief flows are unaffected. Operators with workflows that
relied on autorun picking up uncommitted briefs will see
`skipped: unclean` events and must either commit the brief or
switch to `minifac run`.

The change ships as a single PR; no staged rollout. Existing
tests must continue to pass; new tests cover all branches
(clean, unclean, ancestor-unclean, disabled, `--require-clean`).

## Open Questions

None. The decision doc locked all the open calls.
