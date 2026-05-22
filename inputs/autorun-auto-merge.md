---
change: autorun-auto-merge
factory: sdd
---

## Background

`minifac autorun` does not merge a successful run's branch into the
default branch. `minifac merge` is operator-driven (`src/cli.ts:551`);
autorun completes a run, the runner moves the brief to `inputs/done/`
via `markBriefDone` (`src/runner/run.ts:378`), and the branch is left
on disk for the operator to merge later.

That decoupling is fine for manual workflows, but it creates an
ordering gap with brief dependencies. Today a brief is "done" once
its file is at `inputs/done/<change>.md` (`src/brief/doneness.ts:24`).
So in an autorun chain where brief B `depends_on` A:

1. A finishes successfully, file moves to `inputs/done/A.md`.
2. The scheduler sees A is done, unblocks B.
3. B's worktree is created off `main` — but A's branch is **not** on
   `main` yet because autorun never merged it.
4. B runs against code that doesn't include A's changes.

For autorun chains where each brief is meant to build on the previous
one, this silently produces broken work. Adding the auto-merge step
inside autorun's success path closes the gap: A only counts as "done"
once its code is actually on `main`, so B starts in a worktree that
includes it.

A related but separable mergeability-probe story is being filed as
[[check-merge-step]] — that one is read-only and lives as a built-in
node a factory can include anywhere.

## What to do

Extend `minifac autorun`'s success path so a successful run also
merges the run's branch into the configured base before
`markBriefDone` fires.

**Ordering invariant.** factory success → merge → `markBriefDone`.
If the merge fails, `markBriefDone` does **not** fire; the brief
stays at `inputs/<change>.md` and dependents stay blocked. The runs
row remains `succeeded` (the factory work succeeded); the merge
failure is a separate signal.

**Scope.** Auto-merge fires only inside `autorun`'s success handler,
not in `runner/run.ts`'s general success path. Manual `minifac run`
keeps its existing two-step flow (run, then `minifac merge`). The
blast radius stays contained.

**Merge semantics.** Default = fast-forward with merge-commit
fallback (matches the user preference). New autorun flags mirror
`minifac merge`:

- `--no-auto-merge` — opt out; restore today's behavior.
- `--ff-only` — forbid the merge-commit fallback (same meaning as
  `minifac merge --ff-only`).

The actual merge work reuses `runMerge` from `src/cli/merge.ts` so
behavior, error messages, and edge-case handling stay shared.

**Failure surfacing.** On merge failure, autorun emits a new event
kind `auto-merge-failed` (`change`, `runId`, `reason`) through the
existing event stream so both the raw logger and the TUI render it.
The TUI's brief-row status should reflect "succeeded-but-unmerged"
distinctly from a clean `succeeded`.

**Recovery path.** The operator runs `minifac merge <change>` by
hand to complete the loop. Extend that command to **also call
`markBriefDone` on success** so the recovery path actually moves
the brief to `inputs/done/` and unblocks dependents.
`markBriefDone` is idempotent-safe — if the file is already moved
(non-autorun flow), it's a no-op.

## Out of scope

- **Mergeability check / probe as a workflow node.** Filed
  separately as [[check-merge-step]]. That's read-only; this brief
  is about the action.
- **Falling back to running dependents against the predecessor's
  branch on merge failure.** Considered and rejected for v0 —
  silently building on an unmerged branch compounds debt and makes
  later merges harder. Halt-on-failure is the safe default for
  unattended sessions. Revisit if halt-mode bites too often.
- **Auto-merge in manual `minifac run`.** Keeps the manual
  two-step flow unchanged so existing users don't get surprised.
- **Cycle-on-conflict edge semantics** (e.g. an `on_merge_conflict`
  edge that routes back to `apply`). Captured in
  `docs/Open-Questions.md` under edge & cycle semantics; depends
  on node-outputs maturity so the retry knows what to fix.
- **Pushing the merged branch to a remote.** Autorun is local;
  remote push remains an operator concern.

## Acceptance criteria

- A successful autorun run whose branch fast-forwards (or
  cleanly merges with a merge commit) onto the configured base
  results in the brief being moved to `inputs/done/<change>.md`.
- The base branch has the run's commits when the brief moves.
- A successful run whose merge fails (conflict, divergence) leaves
  the brief at `inputs/<change>.md` and emits an
  `auto-merge-failed` event. The runs row stays `succeeded`.
- A dependent brief that becomes ready only after auto-merge
  succeeds runs against a worktree that includes the predecessor's
  code (asserted by an integration test with a 2-brief chain).
- `minifac autorun --no-auto-merge` reproduces today's behavior
  exactly (no merge call, brief moves to done unconditionally).
- `minifac autorun --ff-only` refuses the merge-commit fallback;
  on non-ff merges it triggers the failure path above.
- `minifac merge <change>` calls `markBriefDone` on success; an
  integration test covers the operator-recovery path
  (auto-merge fails → operator merges manually → brief moves to
  done → dependent unblocks on next poll).
- All existing tests still pass; `npm run build` is clean.
