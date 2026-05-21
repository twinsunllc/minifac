## MODIFIED Requirements

### Requirement: Worktree directory layout and key derivation

minifac SHALL manage worktrees under a `worktrees_dir` whose default
is `~/.minifac/worktrees/`. Each worktree SHALL live at
`<worktrees_dir>/<dir-name>/` where `<dir-name>` is derived as
follows:

- **Brief-driven runs:** `run-<change>-<slug>`
- **Brief-less factory runs:** `run-<factory>-<slug>`

`<change>` is the brief's `change` value. `<factory>` is the loaded
factory object's top-level `name` field. `<slug>` is the first 6
lowercase hexadecimal characters of the run's UUID, derived as
`runId.slice(0, 6).toLowerCase()`.

The `run-` directory-name prefix MIRRORS the `run/` branch-name
prefix (see "Worktree creation via git worktree"), with `/` swapped
for `-` so the name is a single filesystem-flat segment. A reader
inspecting `<worktrees_dir>/` SHALL be able to map each directory
name to its corresponding branch name without consulting any
external state.

The lockfile path (see "Per-key lockfile with PID-bearing claim")
SHALL continue to use the previous key scheme
(`<repo-hash>-<change>` or `<repo-hash>-<factory>-<timestamp>`) and
SHALL NOT change shape under this requirement; the lockfile and the
worktree directory have distinct keys and distinct purposes from
this revision forward.

#### Scenario: Brief-driven worktree path uses run prefix and slug

- **WHEN** `minifac run <brief>` is invoked, the brief's `change` is
  `factory-inputs-core`, and the run's UUID begins with `a7b3c1`
- **THEN** the resolved worktree path is
  `<worktrees_dir>/run-factory-inputs-core-a7b3c1/`

#### Scenario: Brief-less worktree path uses factory name and slug

- **WHEN** `minifac run <name>` resolves to a brief-less factory
  invocation, the factory's `name` is `hello`, and the run's UUID
  begins with `c91d2f`
- **THEN** the resolved worktree path is
  `<worktrees_dir>/run-hello-c91d2f/`

#### Scenario: Two consecutive runs of the same change produce distinct directories

- **WHEN** the user invokes `minifac run <change>` twice in
  succession (the first run terminates, releasing its lock,
  before the second begins)
- **THEN** the two runs produce worktree directories whose names
  differ in the `<slug>` segment, both directories exist on disk,
  and neither invocation fails with "directory already exists"

### Requirement: Worktree creation via git worktree

The CLI SHALL create the worktree by shelling out to
`git -C <caller-cwd> worktree add -b <branch> <worktree-dir>
<base-rev>` where:

- `<branch>` is `run/<change>-<slug>` for brief-driven runs, or
  `run/<factory>-<slug>` for brief-less runs (matching the worktree
  directory naming, with `/` instead of `-` between the `run`
  prefix and the change/factory segment).
- `<slug>` is the first 6 lowercase hexadecimal characters of the
  run's UUID.
- `<base-rev>` is `brief.frontmatter.base_branch` when present;
  else the resolved SHA of the caller's `HEAD` at claim time
  (resolved via `git rev-parse HEAD`).

When `git worktree add` exits non-zero, the CLI SHALL exit `1` with
the git stderr surfaced verbatim, the lock SHALL be released before
exit, and no node SHALL execute.

The created branch SHALL NOT be deleted by minifac during the run
itself, regardless of success or failure. Branch deletion is the
responsibility of the `minifac prune` subcommand (see "Prune
deletes branches it owns") or the operator.

#### Scenario: Branch is named run/<change>-<slug>

- **WHEN** the CLI invokes `git worktree add` for a brief-driven
  run whose `change` is `add-search` and whose run UUID begins
  with `0f1e2d`
- **THEN** the `-b` argument is `run/add-search-0f1e2d`, and the
  resulting worktree's `HEAD` is on that branch

#### Scenario: Brief-less branch is named run/<factory>-<slug>

- **WHEN** the CLI invokes `git worktree add` for a brief-less
  factory invocation whose factory name is `hello` and whose run
  UUID begins with `c91d2f`
- **THEN** the `-b` argument is `run/hello-c91d2f`

#### Scenario: Worktree is created at the resolved path

- **WHEN** the CLI claims the lock and invokes `git worktree add`
  with the resolved path, branch name, and base ref
- **THEN** after the command succeeds, the worktree directory
  exists with a working tree checked out on the new branch

#### Scenario: Failure to create worktree releases the lock

- **WHEN** `git worktree add` exits non-zero (e.g. the resolved
  branch name already exists from a prior run whose slug
  collided)
- **THEN** the CLI exits `1`, the lockfile under `locks_dir` no
  longer exists, and stderr names the git error

#### Scenario: HEAD fallback pins to the SHA at claim time

- **WHEN** the brief omits `base_branch` and the caller's `HEAD`
  resolves to SHA `feedbeef`
- **THEN** the `git worktree add` invocation passes `feedbeef` as
  the base revision (not a symbolic ref), so subsequent HEAD
  movement in the main checkout does not affect the worktree

### Requirement: `minifac prune` subcommand flag matrix

The CLI SHALL expose a `prune` subcommand accepting the following
flags. Flags MAY be combined:

| Flag | Effect |
|---|---|
| (none) | Remove every worktree classified as `merged-old`; keep all others |
| `--all` | Remove every worktree classified as `merged-old`, `unmerged-old`, and `fresh` |
| `--merged` | Remove every worktree classified as `merged-old` (alias of the no-flag default) |
| `--older-than <duration>` | Override the 7-day age cutoff used by classification. Duration syntax: `<int><unit>` with units `m` (minutes), `h` (hours), `d` (days) |
| `--failed` | ALSO remove every worktree classified as `failed` |

When `--all` is supplied without `--failed`, classification's
`failed` bucket SHALL still be excluded — failed runs are never
removed without `--failed`. When `--failed` is supplied alone, only
`failed` worktrees are removed.

For every directory selected for removal, the CLI SHALL execute
`git -C <caller-cwd> worktree remove --force <dir>` first. If that
exits non-zero, the CLI SHALL fall back to `rm -rf <dir>` followed
by `git -C <caller-cwd> worktree prune`.

After the directory removal step succeeds, the CLI SHALL delete the
worktree's branch ref per the "Prune deletes branches it owns"
requirement below.

After processing, the CLI SHALL write a one-line summary to stdout
naming the count removed per bucket. Exit code SHALL be `0` on
successful processing (even if zero directories were removed).

#### Scenario: Default invocation prunes merged-old only

- **WHEN** the user invokes `minifac prune` and the worktrees
  directory contains one of each classification bucket
- **THEN** only the `merged-old` directory is removed; `fresh`,
  `unmerged-old`, and `failed` directories remain

#### Scenario: --all keeps failed worktrees

- **WHEN** the user invokes `minifac prune --all` and the
  worktrees directory contains one `failed` worktree and one
  `fresh` worktree
- **THEN** the `fresh` worktree is removed; the `failed` worktree
  remains

#### Scenario: --failed alone removes only failed worktrees

- **WHEN** the user invokes `minifac prune --failed` and the
  worktrees directory contains one `failed` worktree and one
  `merged-old` worktree
- **THEN** the `failed` worktree is removed; the `merged-old`
  worktree remains

#### Scenario: --all --failed removes everything

- **WHEN** the user invokes `minifac prune --all --failed`
- **THEN** every worktree directory under `worktrees_dir` is
  removed regardless of classification

#### Scenario: --older-than redefines the age cutoff

- **WHEN** the user invokes `minifac prune --older-than 30d` and a
  worktree is 10 days old and merged
- **THEN** classification treats that worktree as `fresh` (10d <
  30d) and it is NOT removed

## ADDED Requirements

### Requirement: Prune deletes branches it owns

`minifac prune` SHALL delete the branch ref of any worktree it
successfully removes, by shelling out to `git -C <caller-cwd>
branch -D <branch-name>` after the worktree directory has been
removed (via `git worktree remove --force` or the `rm -rf`
fallback).

Branch-name resolution SHALL proceed in the following order:

1. Query the runs database (see the `run-storage` capability) for a
   row whose `worktree_path` equals the removed directory. If the
   row exists and its `branch_name` is non-null, use that value.
2. Else, infer the branch name from the directory's leaf name. If
   the leaf matches `^run-` (the new naming from "Worktree
   directory layout and key derivation"), the inferred branch is
   `run/${leaf.slice("run-".length)}` (replace the leading `run-`
   with `run/`).
3. Else (the leaf does not match `^run-`), the directory predates
   this revision and minifac SHALL NOT attempt branch deletion.
   The legacy `<repo-hash>-<change>` naming pointed at a `<change>`
   branch whose lifecycle is the operator's responsibility.

`git branch -D` failure (e.g. branch already deleted, or the branch
is checked out elsewhere) SHALL be surfaced on stderr as a
per-directory warning and SHALL NOT abort prune's processing of
remaining directories. The prune exit code SHALL still be `0` when
the directory removal step succeeded and only the branch step
failed.

Prune SHALL NOT attempt branch deletion when the directory removal
step itself failed (the operator may need to inspect).

#### Scenario: Pruned worktree's branch is deleted

- **WHEN** `minifac prune` removes a worktree directory named
  `run-foo-a7b3c1` and the runs DB row for that worktree carries
  `branch_name = "run/foo-a7b3c1"`
- **THEN** after prune exits, `git branch --list "run/foo-a7b3c1"`
  in the caller's repo produces no output (the branch is gone)

#### Scenario: Retry after failed run is not blocked by orphaned branch

- **WHEN** a `minifac run <change>` invocation fails (leaving the
  worktree and branch in place), the user runs `minifac prune
  --failed` to clean up, and then invokes `minifac run <change>`
  again
- **THEN** the second invocation creates its worktree successfully
  (the prior branch is gone, the new run's branch uses a
  different slug regardless), and no `fatal: a branch named ...
  already exists` error is produced

#### Scenario: Branch deletion falls back to directory-name inference

- **WHEN** `minifac prune` removes a worktree directory named
  `run-bar-c91d2f` and the runs DB has no matching row (e.g.
  the DB file was deleted manually)
- **THEN** prune infers the branch name as `run/bar-c91d2f` and
  attempts `git branch -D run/bar-c91d2f`

#### Scenario: Legacy worktrees are left with their branches intact

- **WHEN** `minifac prune` removes a worktree directory whose
  leaf name does not start with `run-` (e.g. the old
  `<repo-hash>-<change>` form from a build before this change)
- **THEN** prune does not call `git branch -D` for that directory,
  and the operator's legacy branch is left untouched

#### Scenario: git branch -D failure does not abort prune

- **WHEN** prune selects two directories for removal and the
  `git branch -D` step for the first directory exits non-zero
  (e.g. the branch is checked out elsewhere)
- **THEN** prune writes a stderr warning naming the failing
  directory and branch, continues to the second directory, and
  exits `0` (assuming both directory removals themselves
  succeeded)

### Requirement: Lockfile-refused message points at the future --factory flag

The CLI SHALL surface a refused-claim message that points the
user at the future `--factory` flag (see
[`0020-Factory-Override-At-Invocation`](../../../docs/decisions/0020-Factory-Override-At-Invocation.md))
whenever it refuses to claim a lock because the file is held by
a live PID (per "Per-key lockfile with PID-bearing claim"). The
error message SHALL include all of:

- The holding PID
- The resolved lock key
- The lockfile path
- A line clarifying that the lockfile serializes invocations of
  the same `change` even though their branches no longer
  collide, and that `--force` does NOT override the lockfile
- A pointer (text or doc reference) toward the future
  `--factory <name>` flag described in
  [`0020-Factory-Override-At-Invocation`](../../../docs/decisions/0020-Factory-Override-At-Invocation.md)
  as the intended path for legitimate parallel A/B runs against
  the same brief

The message SHALL be written to stderr. The exit code SHALL
remain `1` (unchanged from the existing claim-refused behavior).

#### Scenario: Refused-claim message mentions --factory

- **WHEN** process A holds the lock for `<repo-hash>-foo`, A is a
  running PID, and process B attempts to claim the same key
- **THEN** B's stderr contains the holding PID, the key
  `<repo-hash>-foo`, the lockfile path, the clarification that
  the lock serializes same-change invocations independently of
  branches, and a reference to the future `--factory` flag
