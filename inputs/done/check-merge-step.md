---
change: check-merge-step
factory: sdd
---

## Background

Factories today have no way to ask "is this branch still cleanly
mergeable against its base?" mid-workflow. The runner can attempt the
merge at the end (see [[autorun-auto-merge]]), but by then `apply`
and `verify` have already burned cycles on what might be a doomed
change — `main` may have moved underneath the worktree in a way that
guarantees conflicts.

A read-only mergeability probe as a built-in step lets factories
fast-fail when the base has diverged in a conflicting way. It also
lets factories gate "done" on mergeability without actually
performing the merge (the action stays in the runner per the split
we agreed on — see [[autorun-auto-merge]]).

This step is also the foundation for a future cycle-on-conflict
edge story (the factory routes a conflict back through `apply` with
context), captured in `docs/Open-Questions.md` and gated on the
node-outputs work maturing enough to carry conflict context between
iterations.

## What to do

Add a built-in step `minifac:check-merge` that performs a read-only
mergeability probe against a configured base branch.

**Behavior.**

- Read the current worktree's HEAD and the configured base branch.
- Use `git merge-tree` (or equivalent — `git merge --no-commit
  --no-ff` followed by `git merge --abort` works as a fallback if
  `merge-tree` proves unreliable) to compute whether a merge would
  produce conflicts.
- Exit `0` if the merge would be clean (fast-forward or auto-merge
  with no conflicts).
- Exit non-zero if the merge would conflict.
- Leave the worktree untouched in both cases. No commits, no
  staged changes, no `MERGE_HEAD` / `MERGE_MSG` artifacts.

**Configuration via `with:`.**

- `base: <branch>` — default = the run's configured base branch
  (the same value the worktree was created from). Override for
  unusual flows.
- `mode: "fast-forward" | "any-merge"` — default `any-merge`.
  `fast-forward` exits non-zero if a merge commit would be needed
  even though there are no conflicts; useful for factories that
  want to enforce linear history.

**Where it lives.** Built-in step shipped with the package per
[[0030-Bundle-Builtins]]. Referenced from a node as
`uses: minifac:check-merge`.

**Composability.** Drop the node anywhere in a factory:

- Before `apply` to fast-fail when the base has diverged.
- After `archive` to gate "done" on mergeability without merging.
- Twice (early + late) for paranoid factories.

The SDD factory should adopt it at least once — recommended
placement is after `archive` so the loop self-checks before the
brief moves to done. (That placement also pairs naturally with
[[autorun-auto-merge]]: the runner attempts the actual merge
afterwards and is very likely to succeed because the check just
passed.)

## Out of scope

- **Performing the merge.** That's the runner's job — see
  [[autorun-auto-merge]]. This step is read-only.
- **Emitting structured conflict output** (file list, hunks,
  base SHA) as node outputs that downstream nodes can read.
  Useful for the cycle-on-conflict use case but requires the
  node-outputs surface ([[0027-Node-Outputs]] et al.) to be
  worth threading into a step. v0 returns success/failure only
  via exit code.
- **Cycle-on-conflict edge semantics.** Captured in
  `docs/Open-Questions.md`; depends on the structured-output
  point above.
- **Auto-discovering the base branch from git config.** The base
  is the run's configured base; overrides go through `with:`.
- **Cross-repo / multi-branch mergeability checks.** Single
  worktree, single base, single probe.

## Acceptance criteria

- `minifac:check-merge` is registered as a built-in step
  (resolvable via `uses: minifac:check-merge`); covered by the
  step-registry tests.
- Running the step on a worktree whose HEAD fast-forwards onto
  the base exits `0`.
- Running the step on a worktree whose HEAD merges cleanly with
  a merge commit (default `mode: any-merge`) exits `0`.
- Running the step with `mode: fast-forward` on a worktree that
  would require a merge commit exits non-zero.
- Running the step on a worktree whose merge would conflict
  exits non-zero.
- The worktree is unmodified after the step in every case (no
  `MERGE_HEAD`, no staged conflict markers, working tree clean).
- An example factory or test fixture wires `minifac:check-merge`
  into a graph; the `on_failure` edge routes elsewhere on
  conflict.
- The SDD factory is updated to include a `check-merge` node
  after `archive`.
- All existing tests still pass; `npm run build` is clean.
