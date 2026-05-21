---
change: run-scoped-branches
factory: sdd
base_branch: main
---

## Background

Today each [[Worktree]] is on a branch named exactly `<change>`,
which means retries collide and multiple attempts of the same brief
can't coexist. The binding decision is captured at
`docs/decisions/0019-Run-Scoped-Branches.md` — read it first.

Naming becomes `run/<change>-<slug>` (slug = first 6 hex of the
run UUID). [[Runs-DB]] gains a `branch_name` column. New `minifac
merge` verb covers "ship this specific run." Prune cleans up
branches it owns, resolving the orphan-branch bug by construction.

## What to do

Implement what 0019 describes. Concretely:

### 1. Runs.db migration: `branch_name`

- New `src/storage/migrations/0002_add_branch_name.sql`:

      ALTER TABLE runs ADD COLUMN branch_name TEXT;

- Mirror in `src/storage/migrations/index.ts`'s inline `MIGRATIONS`
  array per the existing convention.
- Update `RunStore` interface and the SQLite adapter to read/write
  the new column. Existing rows have `NULL`; queries tolerate it.

### 2. Branch + worktree naming

- Worktree creation in `src/worktree/` builds the branch name as
  `run/<change>-<slug>`, where `<slug>` is `<run-id>.slice(0, 6)`.
  Brief-less invocations use the factory name in place of `<change>`.
- Worktree directory: `<worktrees_dir>/run-<change>-<slug>/` (or
  `run-<factory>-<slug>` for brief-less).
- Runner writes `branch_name` to the runs.db row at creation.

### 3. Lockfile scope unchanged

- Lockfile stays keyed on `(repo-hash, change)`. Two simultaneous
  invocations of the same change still serialize.
- Note in the lockfile error message that this is intentional and
  `--force` doesn't override it (use the future `--factory` flag
  from [[0020-Factory-Override-At-Invocation]] for legitimate
  parallel A/B runs).

### 4. `minifac merge` subcommand

- New `src/cli/merge.ts` implementing:

      minifac merge <change|run-id> [options]
        --ff-only          refuse merge commits
        --pick             interactive picker if multiple succeeded runs
        --force            allow merging non-succeeded runs

- Resolution:
  - If arg matches a run id (or 6+ char prefix), use that run
  - Else, if arg matches a `change`, list all succeeded runs for
    that change. If exactly one, use it. If multiple, refuse
    unless `--pick` is specified.
  - Else, error.
- Merge behavior:
  - Detect the default branch (`origin/HEAD` or configurable
    via existing `~/.minifac/config.yaml` patterns)
  - Checkout default branch (refuse if uncommitted changes;
    point user at `git stash`)
  - `git merge --ff-only <branch_name>` first; if that fails
    AND `--ff-only` wasn't requested, fall back to a merge
    commit with a clear `Merge run/<change>-<slug>` subject
  - On conflict, abort the merge cleanly and surface the
    conflicting paths
- The merge does NOT delete the run's branch. Prune handles
  branch cleanup later per the hybrid policy.

### 5. Prune cleans up branches

- `src/worktree/prune.ts` gains a small addition: when removing a
  worktree directory + git worktree metadata, ALSO run
  `git branch -D <branch_name>` (read from runs.db, fall back to
  inferring from the worktree's directory name).
- A worktree being pruned for "merged-old" means its branch is
  already merged; `-D` is safe.
- A worktree being pruned for "fresh" (the aborted-invocation
  case) means the branch may not be merged but we made it and
  we're removing it; `-D` is appropriate.
- Failed-run worktrees aren't pruned automatically; their branches
  also persist.

### 6. Tests

- Slug derivation is deterministic from run id
- Branch name format matches `run/<change>-<sha6>` (with brief-less
  variant)
- Two simultaneous `minifac run <same-change>` calls: one succeeds,
  one is refused at the lockfile (and the runs.db has one row, not
  two)
- Two consecutive `minifac run <same-change>` calls produce two
  distinct branches; both exist in git afterward
- `minifac merge <change>` with one succeeded run: fast-forwards
  cleanly; commit lands on default branch
- `minifac merge <change>` with multiple succeeded runs: refused
  with informative message; `--pick` shows the choices
- `minifac merge <run-id>` resolves by id prefix
- Merge with conflicts aborts cleanly
- Prune deletes branches alongside their worktrees (regression
  test for the orphan-branch bug)
- All existing tests still pass

### 7. Specs

- `worktree-management`: MODIFIED requirement for branch naming
  + worktree directory naming + branch cleanup on prune.
- `run-storage`: MODIFIED requirement to add `branch_name` column;
  ADDED scenario for the `0002_*.sql` migration.
- `run-cli`: ADDED requirement for the `minifac merge` subcommand.
  MODIFIED requirement (if needed) for `minifac runs` to surface
  `branch_name`.
- `graph-runner` / `factory-schema` / `node-executor`: probably
  no changes; the runner reads the branch from runs.db and the
  factory has no knowledge of the branch.
- `sdd-factory`: probably no changes — the archive node lands on
  whatever branch the worktree is on.

When MODIFYING, copy the entire requirement block; do not
partial-paste.

### 8. Documentation

- Update `docs/concepts/Worktree.md` with the new naming convention
- Update `docs/concepts/Run.md` to describe `branch_name` and the
  per-run branch identity
- Update `examples/sdd.md` and the README to teach `minifac merge`
- Update `docs/Open-Questions.md`: **remove** the
  "Prune leaves orphaned branches behind" entry — resolved by
  this change.

## Out of scope

- **Factory override at invocation** (`--factory <name>` flag).
  Separate proposal at [[0020-Factory-Override-At-Invocation]].
  This change keeps lockfile scope at `(repo, change)` and the
  brief's `factory:` as authoritative.
- **Auto-merge after successful run.** The user explicitly
  reviews and merges. No automation.
- **Interactive merge picker richness.** `--pick` is a simple
  numbered prompt; fancy TUIs are deferred.
- **Cross-machine merge coordination.** Branches live in the
  local repo; merging is the user's choice.

## Acceptance criteria

- Two consecutive `minifac run <change>` invocations produce two
  distinct branches `run/<change>-<slug1>` and
  `run/<change>-<slug2>`; both exist in git after the second
  invocation
- runs.db rows for those runs carry the correct `branch_name`
- `minifac runs --change <change>` lists both with their branch
  names
- `minifac merge <change>` with exactly one succeeded run fast-
  forwards the default branch
- `minifac merge <change>` with multiple succeeded runs requires
  `--pick`
- `minifac merge <run-id>` resolves correctly by id prefix
- `minifac prune` removes both worktree directories AND their
  branches; a subsequent invocation of the same change isn't
  blocked by orphaned branches
- All existing 332+ tests still pass; new tests cover slug
  derivation, naming, lockfile-still-serializes, merge resolution,
  prune-deletes-branch
- `docs/Open-Questions.md` no longer has the "Prune leaves
  orphaned branches behind" entry

## Note on ordering

This change should land **before** `brief-deps-and-state` so the
`branch_name` column is in place when brief-deps-and-state starts
populating it through its own logic. If this lands first, the
brief-deps-and-state brief's migration step becomes a no-op.
