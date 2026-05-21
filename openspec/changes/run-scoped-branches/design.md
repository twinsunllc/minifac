## Context

Decision [`0019-Run-Scoped-Branches`](../../../docs/decisions/0019-Run-Scoped-Branches.md)
specifies the *what*. This document pins the *how* against the current
codebase.

Current state (relevant excerpts):

- `src/worktree/paths.ts` exports `worktreeKeyForBrief(repoHash,
  change) = "<repo-hash>-<change>"` and a factory variant; both keys
  are used for *both* the lockfile path and the worktree directory
  name today.
- `src/worktree/git.ts` wraps `git worktree add -b <branch>
  <worktree-dir> <base-rev>`. The branch passed today is exactly the
  brief's `change` (or the factory-timestamp suffix).
- `src/worktree/prune.ts` removes worktree directories via `git
  worktree remove --force` with an `rm -rf` + `git worktree prune`
  fallback. It does not touch branch refs — that's the bug.
- `src/storage/migrations/index.ts` carries an ordered `MIGRATIONS`
  array; the only entry is `0001_initial.sql` (the v1 schema
  including the `runs` table). The SQLite adapter applies pending
  migrations on open.
- `src/storage/run-store.ts` defines the `RunStore` interface used by
  the CLI and the daemon. `createRun` takes an input object with
  metadata (factory paths, change, base branch, worktree path) and
  returns the full row.
- `src/cli.ts` (and helpers under `src/cli/`) sequence the run:
  resolve → lazy-prune → claim lock → create worktree → invoke
  runner → finalize.

Constraints from `CLAUDE.md`:

- TypeScript strict mode, tests beside code.
- Names follow behavior (no anthropomorphic metaphors). The branch
  is a branch, the slug is a slug.
- No new runtime dependencies. We already shell out to `git`.
- The directory `src/worktree/` is the home for worktree machinery;
  this change extends two files there, doesn't add a new
  subdirectory.

## Goals / Non-Goals

**Goals:**

- A failed `minifac run <change>` followed by a fresh `minifac run
  <change>` invocation succeeds without manual `git branch -D`.
- Two consecutive runs of the same change produce two distinct
  branches, both visible in `git branch --list 'run/<change>-*'`.
- `minifac merge <change>` is the documented "ship this run" verb,
  with the obvious fast-forward path and a sane fallback to a
  merge commit.
- `minifac prune` deletes branch refs of worktrees it removes; the
  orphan-branch Open-Question entry can be deleted.
- `minifac runs` shows the branch name so users can see at a glance
  what to merge.
- All existing tests stay green; new tests cover the new surface.

**Non-Goals:**

- No widening of the lockfile scope to `(repo, change, factory)`.
  That's a separate ADR
  ([`0020-Factory-Override-At-Invocation`](../../../docs/decisions/0020-Factory-Override-At-Invocation.md)).
- No automatic merge. The operator runs `minifac merge` explicitly.
- No fancy `--pick` TUI; v0 is a numbered stdin prompt.
- No cross-machine coordination. Branches are local.
- No deletion of *unowned* branches. Prune only deletes branches
  whose worktree it just removed.

## Decisions

### Decision: Slug is 6 hex chars of the run UUID

The run id today is a UUID v4. The slug is `runId.slice(0, 6)` after
lowercasing. Six hex chars yields 16,777,216 distinct values per
change — collisions within the same change name are
vanishingly rare in practice (we'd need ~4,000 retries of the same
brief before a 1% chance), and the slug is short enough to fit in
shell completion comfortably.

**Why not a counter (`run/<change>-1`, `-2`):** would require
consulting global state to assign the next number. UUID-derived
slug is collision-free without any cross-process coordination.

**Why not a timestamp:** uglier, sub-second collisions are possible
on retry loops, and the slug wouldn't tie back to the run id (which
is what `minifac runs` lists).

**Why 6 chars and not 8:** 8 is overkill for a per-change scope.
6 is enough that two retries within the same hour collide with
probability ~1e-7. If a real collision is ever observed, widening
to 7 or 8 is a one-line change in `paths.ts` and a spec update;
slugs are display-only and not used as identifiers elsewhere.

### Decision: Worktree directory name drops the repo-hash prefix

Old: `<worktrees_dir>/<repo-hash>-<change>/`.
New: `<worktrees_dir>/run-<change>-<slug>/`.

Two reasons:

1. The repo-hash was already redundant when `<worktrees_dir>` was
   per-repo via `<repo>/.minifac/config.yaml` (the per-repo config
   already disambiguates). For the global `~/.minifac/worktrees/`
   case, the `run-` prefix on the directory name continues to
   distinguish minifac-owned worktrees from anything else a user
   might park there.
2. The slug carries the disambiguation between retries. With the
   slug in the name, the repo-hash adds noise without information.

The `run-` prefix on the dir matches the `run/` prefix on the branch
name (with `/` swapped for `-` because filesystems vary in their
willingness to nest under slashes inside a leaf). A reader
inspecting `~/.minifac/worktrees/` SHOULD see a 1:1 correspondence
between directory names and branch names modulo separator.

**Why not keep the repo-hash:** if a user has two distinct repos
that happen to share a `change` name, the slug still
disambiguates (different UUIDs → different slugs). The lockfile
still carries the repo-hash so concurrent runs of the same change
across different checkouts of the same logical repo still
serialize (which is the correct behavior — `git worktree` does
not support cross-checkout coordination).

### Decision: Lockfile key unchanged

The lockfile keeps the existing `<repo-hash>-<change>.lock`
(brief-driven) or `<repo-hash>-<factory>-<timestamp>.lock`
(brief-less). The purpose of the lockfile is to serialize
invocations against the same brief on the same machine; that
property is independent of the per-run branch identity.

A second `minifac run <same-change>` still refuses at the lockfile
even though its branch would no longer collide. The refused-claim
error message is updated to clarify that `--force` does not
override the lockfile, and points the user at
[`0020-Factory-Override-At-Invocation`](../../../docs/decisions/0020-Factory-Override-At-Invocation.md)
for legitimate parallel A/B runs.

**Why preserve the lockfile when branch collisions are gone:** the
lockfile still protects against two simultaneous invocations
mutating the same brief's inputs / SDD spec deltas. A second
invocation that finds the first mid-run is almost always a
mistake, not an intent. The user who genuinely wants parallel
runs of the same change has them through the future `--factory`
flag, which widens the lock key.

### Decision: Branch name is built where the worktree is created

The CLI's run action computes the branch name and worktree dir name
from `runId` and `change` (or `factoryName`) at the moment it's
about to call `git worktree add`. No code path elsewhere needs to
derive these — they are persisted to the runs DB (`branch_name`,
`worktree_path`) and read back by the consumers (`minifac merge`,
`minifac prune`, `minifac runs`).

This places the truth-source in the database row, not in a naming
convention. Prune can still fall back to deriving the branch from
the directory name (`run-<change>-<slug>` → `run/<change>-<slug>`)
when the runs DB does not have a matching row (a worktree created
by a build of minifac before this change, or a worktree whose row
was manually deleted). The fallback is documented as such.

**Why not derive everywhere from a single helper:** the runs DB
serves another purpose — `minifac merge` needs the branch name
without parsing directory names, and the daemon viewer needs it
without re-running the slug derivation. Persisting it once at
creation time is the simplest API.

### Decision: `branch_name` is a nullable TEXT column

Existing runs in the DB (from before this change) have no branch
information persisted. Their rows get `branch_name = NULL`. The
SQL migration `0002_add_branch_name.sql` adds the column without a
backfill:

```sql
ALTER TABLE runs ADD COLUMN branch_name TEXT;
```

Consumers tolerate `NULL`:

- `minifac runs` renders an empty string in the human table and
  emits `null` (or omits the field — TBD by the existing JSON
  shape) in `--json`.
- `minifac merge <change>` ignores rows with `NULL` branch_name
  when resolving (they correspond to runs from a pre-change build
  that the operator must merge manually with `git merge <change>`
  if at all).
- `minifac prune` falls back to inferring the branch from the
  worktree directory name when the DB row is missing or has
  `branch_name = NULL`.

**Why nullable instead of a backfill migration:** the pre-change
branch was always exactly `<change>`. We *could* backfill
`branch_name` for existing rows by reading `change` and prefixing
`run/`. But that lie would be visible the moment the user tried
to `minifac merge <pre-change-run-id>` — the branch
`run/<change>-<slug>` would not exist, and the merge would fail
with a confusing error. Better to leave `NULL` and let the
operator know explicitly that pre-change runs use the legacy
naming.

### Decision: `minifac merge <arg>` resolution order

Given a single positional argument `<arg>`:

1. If `<arg>` is a hex string of length ≥ 6 AND matches the prefix
   of exactly one row's `id` in the `runs` table, resolve to that
   row.
2. Else, treat `<arg>` as a `change` value. Query for rows whose
   `change = <arg>`.
   - Filter to rows with `status = 'succeeded'` unless `--force`.
   - If zero matches: error.
   - If exactly one match: use that row.
   - If multiple matches:
     - Without `--pick`: error listing the matching runs and
       suggest `--pick` or passing a run id.
     - With `--pick`: interactive numbered prompt over
       `process.stdin`. The list shows id-prefix, status, started-at,
       and branch name. Empty input or EOF aborts with exit 1.
3. Else, error naming the input and the resolution attempts.

The ambiguity between "this is a hex run-id prefix" and "this is a
change name" is resolved by the first match: if the arg matches a
run id prefix, we use it; otherwise we try `change`. A
sufficiently short hex arg (`<6` chars) is always treated as a
change name, even if it happens to look like hex.

**Why `--pick` is a stdin prompt and not a fzf-style TUI:** v0 keeps
the CLI dep-free. The pickable list is short by definition (one
brief's runs); a numbered prompt is fine. A future
`--pick=interactive` flag may grow a TUI.

### Decision: Merge sequence and fallback

The `merge` subcommand executes the following sequence in the
caller's repo (cwd):

1. Resolve the run row (above).
2. Verify `branch_name` is non-null. If null, error: "this run
   pre-dates per-run branch naming; merge manually with
   `git merge <change>` if appropriate."
3. Detect the default branch:
   - Configured: `worktree-management` config's `default_branch`.
   - Else: the branch `origin/HEAD` points to.
   - Else: `main`.
4. Verify the current `git status` is clean (no uncommitted
   changes). If dirty, error pointing the user at `git stash`.
5. `git checkout <default-branch>` (only if not already on it).
6. `git merge --ff-only <branch_name>`. If that succeeds, print a
   one-line summary naming the merged branch and the resulting
   HEAD SHA, exit 0.
7. If `--ff-only` was supplied AND step 6 failed: print the git
   stderr verbatim, exit 1.
8. Otherwise, run `git merge --no-ff -m "Merge <branch_name>"
   <branch_name>`. On success, print the summary and exit 0.
9. On merge conflict at step 8, run `git merge --abort` to leave a
   clean tree, print the conflicting paths (from `git diff
   --name-only --diff-filter=U`), and exit 1.

The merge does NOT delete the run's branch. Prune deletes branches
when it removes worktrees; manual `git branch -d
<branch_name>` is also fine.

**Why fast-forward first:** the common case is "run created N
commits on top of the default branch; default branch hasn't moved
since." A merge commit there is noise. The merge-commit fallback
covers the case where the default branch has advanced.

**Why refuse on dirty tree:** merging into a dirty tree mixes the
user's in-progress work with the run's commits in a way that is
hard to undo cleanly. Refusing is safer; the workaround
(`git stash`) is one command.

### Decision: Prune deletes branches it owns

`prune.ts` already invokes `git -C <repo> worktree remove --force
<dir>`. After that succeeds (or after the `rm -rf` fallback
succeeds), prune additionally:

1. Determines the branch name:
   - Query the runs DB by `worktree_path = <dir>`. If a row with
     non-null `branch_name` is found, use that.
   - Else, infer from the directory leaf: strip the `run-` prefix
     to get `<change>-<slug>`, then prepend `run/`. This
     fall-back covers worktrees created with the new naming
     whose runs DB row is missing.
   - If the directory does not match `^run-` (a legacy
     pre-change worktree, e.g. `<repo-hash>-<change>`), prune
     SHALL NOT delete any branch — the legacy naming pointed
     directly at `<change>`, and deleting that is the operator's
     call.
2. Run `git -C <repo> branch -D <branch-name>`. Failure (e.g.
   branch already deleted) is logged on stderr but does not
   abort processing the rest of the prune set.

**Why only delete branches under `run/`:** the prefix is minifac's
namespace. Anything else is presumed user-owned.

**Why `-D` and not `-d`:** `-d` refuses unmerged branches.
- For `merged-old` worktrees, the branch is merged → both `-d`
  and `-D` work.
- For `fresh` worktrees pruned via `--all`, the branch may be
  unmerged → `-D` is required.
- For `failed` worktrees pruned via `--failed`, same.
The operator opted into prune; we trust the call.

### Decision: RunStore interface gains `branchName?: string`

The `RunStore` interface changes minimally:

```ts
// CreateRunInput gains:
branchName?: string;

// The returned Run shape gains:
branchName: string | null;
```

The SQLite adapter:

- INSERT statement adds `branch_name` to the column list and
  binds the input value (or `NULL` when absent).
- SELECT statements (`getRun`, `listRuns`) include the new column
  in their projections and map it onto the returned object.
- Migrations apply on open, so an opened DB transparently picks
  up `0002`.

**Why optional on input:** existing call sites (tests, brief-less
factory invocations that don't go through the CLI's worktree
path) may construct `Run` rows without a branch. Making it
optional lets them keep working.

## Risks / Trade-offs

- **[Slug collisions within the same change]** → Mitigation:
  acceptable. 6 hex chars = 16M values; even with 1000 retries of
  the same brief, the collision probability is ~3e-5. If a real
  collision is observed (the next `git worktree add` would fail
  with "branch already exists"), the CLI surfaces the git error
  and exits 1; the user retries (gets a new UUID, new slug). The
  spec pins the 6-char width so widening it later is intentional.
- **[Legacy worktrees from before this change]** → Mitigation:
  prune's "match `^run-` only" rule skips them; they remain as
  before until manually deleted. The runs DB rows for those runs
  have `branch_name = NULL` and `minifac merge` refuses them with
  an instructive message.
- **[`minifac merge` on a non-default branch]** → Mitigation: the
  subcommand checks out the default branch first; the operator
  who wants to merge into a feature branch can do `git merge`
  manually. Documented in the `merge --help`.
- **[Multiple succeeded runs of the same change]** → Mitigation:
  `--pick` exists for the interactive case; `minifac merge
  <run-id>` is the scriptable case. Without either, the
  subcommand refuses with a list of the matching runs.
- **[A pre-change DB upgraded mid-flight]** → Mitigation: the
  schema migration adds `branch_name` nullable; new rows persist
  the value; old rows keep `NULL`. No reader assumes non-null;
  every consumer has a documented fallback (skip / infer / show
  blank).
- **[Prune deletes a branch that has other unmerged work]** →
  Mitigation: the branch is `run/<change>-<slug>` — minifac's
  namespace. The slug is per-run; no other process creates
  `run/<change>-<slug>` for an unrelated purpose. If a user
  manually committed to `run/<change>-<slug>` after the run
  completed, they opted into minifac's namespace and the prune
  semantics. Documented in `prune --help`.
- **[Merge conflicts on the squash-merge heuristic vs the new
  merge command]** → Out of scope. Prune's squash-merge heuristic
  (from
  [`0010-Worktree-Cleanup-Hybrid`](../../../docs/decisions/0010-Worktree-Cleanup-Hybrid.md))
  classifies worktrees for the *prune* policy; the new `merge`
  verb performs git merges and is unrelated.

## Migration Plan

No production data, no users outside minifac developers. The
runs DB may carry rows on contributors' machines.

1. Land `src/storage/migrations/0002_add_branch_name.sql` and
   mirror it in the inline `MIGRATIONS` array. Verify that
   opening an existing DB applies the migration cleanly and
   leaves old rows with `branch_name = NULL`.
2. Extend `RunStore` and the SQLite adapter to read/write
   `branchName`.
3. Add `runSlugFromId`, `runBranchName`, `runWorktreeDirName`
   helpers under `src/worktree/paths.ts`. Add corresponding
   tests.
4. Update `src/cli.ts` (or wherever the run action lives) to
   compute the branch name and worktree directory name from
   `runId + change/factoryName` and to pass `branchName` to
   `createRun`. The lockfile claim continues to use the
   existing key.
5. Update `src/worktree/git.ts` with `gitBranchDelete`.
6. Update `src/worktree/prune.ts` to call `gitBranchDelete`
   after each successful directory removal, with the documented
   resolution order and `^run-` guard.
7. Add `src/cli/merge.ts` and `src/cli/merge.test.ts`. Wire the
   subcommand into the CLI's dispatcher.
8. Update `src/cli/runs.ts` to render `branch_name`.
9. Refresh docs and `examples/sdd.md` / `README.md`.
10. Remove the orphan-branch entry from `docs/Open-Questions.md`.

A pre-change contributor checking out this branch and running
`minifac run <change>` after `minifac prune` is the regression
test for the bug; the new CI test asserts the branch is gone
after prune.

## Open Questions

- **Should `minifac merge` ever run `git fetch` before the merge?**
  Decision: no for v0. The merge operates purely on local refs.
  An operator who wants the latest default-branch from the
  remote runs `git pull` themselves. Documented in `merge
  --help`.
- **Should `minifac merge --pick` show a one-line preview of the
  run (e.g. last commit subject)?** Decision: no for v0. The
  picker shows id, status, branch, and started-at. Richer
  previews wait for a real TUI.
- **Should the runs.db backfill `branch_name` for pre-change
  rows?** Decision: no. The legacy branch (`<change>`) may not
  even exist anymore (the user could have deleted it); leaving
  `NULL` is honest.
- **Should `git worktree add` use the SHA of `origin/HEAD` as the
  base when the brief omits `base_branch`?** Decision: out of
  scope. The existing behavior (resolve `HEAD` SHA) is preserved
  unchanged.
- **Should prune attempt to delete the branch when the worktree
  removal *failed*?** Decision: no. Branch deletion is conditioned
  on successful directory removal; a failed remove leaves the
  branch alone (the operator may need to inspect).
