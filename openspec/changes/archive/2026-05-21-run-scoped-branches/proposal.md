## Why

Today every [[Worktree]] for a [[Run]] checks out a branch named exactly
`<change>`. Two consequences fall out:

1. **Retries collide.** A failed run leaves the `<change>` branch behind.
   `minifac prune` removes the worktree directory and git's internal
   worktree metadata but not the branch ref, so the next `minifac run
   <same-change>` fails with `fatal: a branch named X already exists`.
   This bug is filed in `docs/Open-Questions.md` and the user just hit
   it during dogfood.
2. **Each brief gets at most one runnable branch at a time.** Multiple
   attempts of the same brief (different factories, different models,
   factory iteration) can't coexist as diffable artifacts; comparing
   two runs of the same change requires manual checkpointing.

Decision [`0019-Run-Scoped-Branches`](../../../docs/decisions/0019-Run-Scoped-Branches.md)
binds the answer. Branches become per-run: `run/<change>-<slug>` where
`<slug>` is the first 6 hex of the run UUID. Retries don't collide,
multiple attempts coexist, and the orphan-branch Open-Question
dissolves by construction.

The flip side is that "ship a successful run" — previously implicit in
`git merge <change>` — needs a small affordance: which run to merge,
and from where. A new `minifac merge` verb covers the common case.

This change should land *before* `brief-deps-and-state` so the
`branch_name` column is in place when that capability starts populating
and reading it.

## What Changes

- **MODIFIED** worktree-management. The worktree's branch SHALL be named
  `run/<change>-<slug>` (brief-driven) or `run/<factory>-<slug>`
  (brief-less), where `<slug>` is the first 6 lowercase hex characters
  of the run's UUID. The worktree directory SHALL be
  `<worktrees_dir>/run-<change>-<slug>/` (or `run-<factory>-<slug>/`),
  replacing the previous `<repo-hash>-<change>` directory naming.
- **MODIFIED** worktree-management. `minifac prune` SHALL delete the
  branch ref of any worktree it removes (via `git branch -D
  <branch_name>`). The branch name is read from the run's row in the
  runs database when available, falling back to a derivation from the
  worktree directory name. This resolves the orphan-branch bug.
- **UNCHANGED** lockfile scope. Lockfile keys remain
  `<repo-hash>-<change>` (brief-driven) or
  `<repo-hash>-<factory>-<timestamp>` (brief-less). Two simultaneous
  invocations of the same change still serialize at the lockfile, even
  though their branches no longer collide. The lockfile error message
  SHALL note that `--force` does not override the lockfile and direct
  the user toward the future `--factory` flag from
  [[0020-Factory-Override-At-Invocation]] for legitimate parallel A/B
  runs.
- **MODIFIED** run-storage. The `runs` table SHALL gain a
  `branch_name TEXT` column. A new schema migration
  `0002_add_branch_name.sql` SHALL add the column on existing
  databases; new databases pick it up alongside the v1 schema.
  Existing rows have `NULL`; reads SHALL tolerate it. The `RunStore`
  interface's `createRun` input SHALL accept an optional `branchName`
  string and persist it on the row.
- **NEW** `minifac merge` subcommand. The CLI SHALL expose a
  `merge <change|run-id>` verb that resolves the run's branch via
  `runs.branch_name`, checks out the default branch in the caller's
  checkout, and merges the run's branch. Flags: `--ff-only` (refuse
  merge commits), `--pick` (interactive picker for the multi-success
  case), `--force` (allow merging non-succeeded runs). Conflict
  aborts cleanly; the branch is not deleted by merge (prune handles
  that later).
- **MODIFIED** run-cli. `minifac runs` SHALL surface `branch_name` in
  both the human table (a new column or visible field) and the
  `--json` output. The behavior for runs predating the column
  (`branch_name === null`) is to render an empty field.

## Capabilities

### Modified Capabilities

- `worktree-management`: branch naming, worktree directory naming, and
  the prune-deletes-branches behavior change. The lockfile-scope,
  hybrid-prune-policy, lazy-prune, journal, and config-file requirements
  are unchanged.
- `run-storage`: a new `branch_name` column on `runs`; a new migration
  `0002_add_branch_name.sql`; the `RunStore` interface grows
  `branchName?: string` on `createRun` input and on the returned run
  shape.
- `run-cli`: the `runs` subcommand surfaces `branch_name`; a new
  `merge` subcommand lands.

### New Capabilities

None — this change is fully expressed as modifications to existing
capabilities. The `minifac merge` verb belongs to `run-cli` (the same
capability that owns `run`, `prune`, `runs`).

## Impact

- `src/storage/migrations/0002_add_branch_name.sql` (new file).
- `src/storage/migrations/index.ts`: append the new migration to the
  inline `MIGRATIONS` array (mirroring the SQL file).
- `src/storage/run-store.ts`: the `RunStore` interface gains
  `branchName?: string` in `CreateRunInput` and on the returned `Run`
  shape. The SQLite adapter reads/writes the new column; the
  in-memory test adapter (if present) does the same.
- `src/worktree/paths.ts`: new helpers `runSlugFromId(runId: string):
  string` (returns `runId.slice(0, 6).toLowerCase()`),
  `runBranchName(change: string, slug: string)` (returns
  `run/${change}-${slug}`), and `runWorktreeDirName(change: string,
  slug: string)` (returns `run-${change}-${slug}`). The existing
  `worktreeKeyForBrief` / `worktreeKeyForFactory` keys remain for the
  lockfile.
- `src/worktree/git.ts`: a small wrapper `gitBranchDelete(repoCwd,
  branch, { force }): Promise<void>` over `git -C <cwd> branch -D
  <branch>` so prune can clean up branches alongside worktrees.
- `src/worktree/prune.ts`: when removing a worktree, look up the
  branch name (from the runs DB if available, fall back to inferring
  from the directory name `run-<change>-<slug>` → `run/<change>-<slug>`)
  and call `gitBranchDelete` after the worktree removal succeeds.
  Failures of `gitBranchDelete` are surfaced on stderr but do not
  abort processing.
- `src/cli.ts` + `src/cli/run.ts` (or wherever the run action lives):
  build the run's branch name and worktree directory name from the
  run id at creation time; pass the resulting `branchName` and
  `worktreePath` to `git worktree add` and persist `branchName` to
  the runs.db row via the existing `createRun` call. The lockfile
  claim continues to use the existing repo-hash-change key.
- `src/cli/merge.ts` (new): implements `minifac merge <arg>` with
  the resolution, fast-forward + fall-back-to-merge-commit, conflict
  abort, and `--pick`/`--ff-only`/`--force` semantics.
- `src/cli/merge.test.ts` (new): covers the resolution matrix,
  conflict handling, branch-not-deleted-by-merge, and `--pick`
  prompts.
- `src/cli/runs.ts`: render `branch_name` in the default table (a
  truncated rendering is acceptable to keep the row width sane) and
  in the JSON output. Tests updated.
- `src/worktree/paths.test.ts`: cover slug derivation,
  branch-name shape, and worktree-dir-name shape, including the
  brief-less factory variant.
- `src/worktree/prune.test.ts`: extend the existing prune tests to
  assert the branch ref is gone after prune (regression test for
  the orphan-branch bug).
- `docs/concepts/Worktree.md`: replace the old naming convention
  with the new one; add a paragraph about retries-don't-collide.
- `docs/concepts/Run.md`: describe `branch_name` and the per-run
  branch identity.
- `examples/sdd.md` and `README.md`: teach the new branch shape and
  `minifac merge`.
- `docs/Open-Questions.md`: remove the "Prune leaves orphaned
  branches behind" entry (resolved by this change).

### Out of scope

- **Factory override at invocation** (`--factory <name>` flag).
  Tracked at
  [`0020-Factory-Override-At-Invocation`](../../../docs/decisions/0020-Factory-Override-At-Invocation.md);
  separate change. This change keeps lockfile scope at
  `(repo, change)`.
- **Auto-merge after a successful run.** The user explicitly reviews
  and merges. No automation.
- **Fancy `--pick` UI.** v0 is a simple numbered prompt over stdin.
- **Cross-machine merge coordination.** Branches are local; merging
  is the user's choice.
