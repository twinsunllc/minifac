# worktree-management Specification

## Purpose
TBD - created by archiving change worktree-mode. Update Purpose after archive.
## Requirements
### Requirement: Worktree directory layout and key derivation

minifac SHALL manage worktrees under a `worktrees_dir` whose default
is `~/.minifac/worktrees/`. Each worktree SHALL live at
`<worktrees_dir>/<dir-name>/` where `<dir-name>` is derived as
follows:

- **Brief-driven runs:** `run-<change>-<slug>`
- **Brief-less factory runs:** `run-<factory>-<slug>`

`<change>` is the brief's `change` value. `<factory>` is the loaded
factory object's top-level `name` field (the factory actually used
for the run, which reflects the `--factory` CLI override when
supplied, otherwise the brief's declared factory). `<slug>` is the
first 6 lowercase hexadecimal characters of the run's UUID, derived
as `runId.slice(0, 6).toLowerCase()`.

The `run-` directory-name prefix MIRRORS the `run/` branch-name
prefix (see "Worktree creation via git worktree"), with `/` swapped
for `-` so the name is a single filesystem-flat segment. A reader
inspecting `<worktrees_dir>/` SHALL be able to map each directory
name to its corresponding branch name without consulting any
external state. The factory used for a run is NOT encoded in the
worktree directory name; consumers who need that information SHALL
consult the persisted run row's `factoryName` column (per the
`run-storage` capability).

The lockfile path (see "Per-key lockfile with PID-bearing claim")
uses a DIFFERENT key scheme than the worktree directory:

- For brief-driven runs, the lockfile key is
  `<repo-hash>-<change>-<factory>`, where `<factory>` is the
  resolved factory's top-level `name` field (override-aware, per
  above). Two concurrent invocations of the same `(change,
  factory)` pair SHALL collide on the same lockfile and serialize;
  two concurrent invocations of the same `change` through
  *different* factories SHALL claim distinct lockfiles and proceed
  in parallel.
- For brief-less factory runs, the lockfile key remains
  `<repo-hash>-<factory>-<timestamp>` (per-invocation by
  construction).

The lockfile and the worktree directory have distinct keys and
distinct purposes: the lockfile expresses "what concurrent
invocations should serialize," and the directory expresses "what
on-disk artifact this specific run produced."

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

#### Scenario: Brief-driven lockfile key includes the factory name

- **WHEN** `minifac run foo --factory bar` is invoked and the
  repo-hash resolves to `abcd`
- **THEN** the lockfile path is `<locks_dir>/abcd-foo-bar.lock`
  (the lock key is `abcd-foo-bar`, including the factory segment),
  regardless of what the brief declared

#### Scenario: Two runs of the same brief through different factories use distinct lockfiles

- **WHEN** one invocation runs `foo` through factory `A` and a
  parallel invocation runs `foo` through factory `B` against the
  same repo-hash `abcd`
- **THEN** the two lockfiles are `<locks_dir>/abcd-foo-A.lock` and
  `<locks_dir>/abcd-foo-B.lock` (distinct paths); both claims
  succeed independently

#### Scenario: Brief-less lockfile key is unchanged

- **WHEN** `minifac run hello` resolves as a brief-less factory
  invocation, the repo-hash resolves to `abcd`, and the run's
  timestamp segment is `1716300000`
- **THEN** the lockfile path is
  `<locks_dir>/abcd-hello-1716300000.lock`, matching the prior
  brief-less key shape

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

### Requirement: Per-key lockfile with PID-bearing claim

minifac SHALL maintain lockfiles under a `locks_dir` whose default
is `~/.minifac/locks/`. The lockfile path for a run SHALL be
`<locks_dir>/<key>.lock`, where `<key>` is the run's lockfile key
as derived by "Worktree directory layout and key derivation" — i.e.
`<repo-hash>-<change>-<factory>` for brief-driven runs and
`<repo-hash>-<factory>-<timestamp>` for brief-less runs. The
lockfile key is independent of the worktree directory name; the
two have distinct purposes (serialization vs. on-disk artifact
identity).

Claim semantics:

- The CLI SHALL create the lockfile atomically using an
  exclusive-create open (e.g. `O_CREAT | O_EXCL`) and SHALL write
  the owning PID as a decimal string followed by a newline.
- If the exclusive create fails because the file already exists,
  the CLI SHALL read the existing PID. If the PID cannot be parsed
  or is `<= 0`, the lock SHALL be treated as stale; the CLI SHALL
  atomically replace the file (e.g. write-tmp + rename) and claim
  it.
- If the PID parses to a positive integer, the CLI SHALL probe
  liveness via a zero-signal kill. If the process is verifiably
  absent (e.g. `ESRCH`), the lock SHALL be treated as stale and
  reclaimed atomically. Otherwise the claim SHALL fail and the CLI
  SHALL exit `1` with a message that names the holding PID, the
  resolved lock key, and the lockfile path.

Release semantics:

- The CLI SHALL release the lock with a best-effort `unlink` of the
  lockfile in a `try/finally` around the run. A missing file at
  release time SHALL NOT be an error (it indicates the file was
  reclaimed as stale by a parallel process; the conservative branch
  refuses, so this case is not racy).
- Crash-before-release SHALL be tolerated by the stale-detection
  branch on the next claim.

The lock SHALL be claimed BEFORE worktree creation begins and
BEFORE any node executes, so failed worktree creation does not
leave a partial run claiming a key.

#### Scenario: Concurrent claim of the same key is refused

- **WHEN** process A holds the lock for key `abcd-foo-sdd`, A is a
  running PID, and process B attempts to claim the same key
- **THEN** B exits `1` with an error naming A's PID, the key
  `abcd-foo-sdd`, and the lockfile path, and B does NOT create a
  worktree

#### Scenario: Different keys run in parallel

- **WHEN** process A holds the lock for `abcd-foo-sdd` and process
  B attempts to claim `abcd-foo-sdd-with-codex` (same change, a
  different factory)
- **THEN** B's claim succeeds and B proceeds to create its own
  worktree under a different directory; A's claim is unaffected

#### Scenario: Stale lock from a dead PID is reclaimed

- **WHEN** a lockfile contains the PID `99999`, no process with PID
  `99999` is running, and a new minifac process attempts to claim
- **THEN** the new process replaces the lockfile contents with its
  own PID and proceeds to create the worktree

#### Scenario: Unparseable lock contents are reclaimed

- **WHEN** a lockfile contains arbitrary garbage (no parseable PID)
  and a new minifac process attempts to claim
- **THEN** the new process treats the lock as stale, replaces it
  atomically, and proceeds

#### Scenario: Lock is released on successful run

- **WHEN** a run terminates with status `succeeded`
- **THEN** the lockfile no longer exists at `<locks_dir>/<key>.lock`

#### Scenario: Lock is released on failed run

- **WHEN** a run terminates with status `failed` (any reason)
- **THEN** the lockfile no longer exists at `<locks_dir>/<key>.lock`

### Requirement: Failed-run journal records non-success terminations

minifac SHALL append an entry to a journal at
`~/.minifac/failed-runs.json` whenever a run ends with status other
than `succeeded`. The journal SHALL be a JSON object with an
`entries` array; each entry SHALL be an object with at least:

- `worktreeDir` (string, absolute path) — the worktree directory of
  the run, or the caller's cwd when the run was `--in-place`
- `status` (string) — the terminal run status, typically `failed`
- `endedAt` (string, ISO 8601 timestamp) — when the run terminated
- `reason` (string, optional) — a short human-readable description

If the journal file is missing, the CLI SHALL treat it as empty for
the purposes of reads and SHALL create the file on first write. If
the journal file exists but cannot be parsed as JSON, the CLI SHALL
treat it as empty for the purposes of reads, MAY log a single
warning to stderr, and SHALL NOT abort the run on account of the
journal.

The journal SHALL be capped at the most recent 1000 entries; on
append, older entries SHALL be trimmed from the head of the array.

The journal is documented as a transitional store; a future
`runs.db` (out of scope here) supersedes it without changing the
consumer contract (`pruneWorktrees`).

#### Scenario: Failed run appends an entry

- **WHEN** a run terminates with status `failed`
- **THEN** `~/.minifac/failed-runs.json` exists after the run and
  its `entries` array contains a new object with the run's
  `worktreeDir`, `status: "failed"`, an `endedAt` ISO timestamp,
  and (when known) a `reason` string

#### Scenario: Successful run does NOT append an entry

- **WHEN** a run terminates with status `succeeded`
- **THEN** no new entry is appended to the journal (a missing file
  remains missing; an existing file is unchanged in content)

#### Scenario: Journal trims to 1000 entries

- **WHEN** the journal already contains 1000 entries and a new
  failed-run entry is appended
- **THEN** the journal contains exactly 1000 entries, the new entry
  is present, and the oldest prior entry has been removed

### Requirement: Hybrid prune policy classification

`minifac prune` (and the lazy-prune entry point) SHALL classify each
directory under `worktrees_dir` into exactly one of these buckets:

- `failed` — there exists an entry in the failed-run journal for
  this worktree directory whose `status` is not `succeeded`
- `fresh` — not `failed`, and `Date.now() - dir.mtime < 7 days`
- `merged-old` — not `failed`, age `≥ 7 days`, and the worktree's
  branch is reachable in the repo's default branch by either
  `git branch --merged <default>` OR the squash-merge heuristic
  described below
- `unmerged-old` — not `failed`, age `≥ 7 days`, and the branch is
  not reachable per the above

The default branch SHALL be resolved as follows, in order:

1. The `default_branch` field of `~/.minifac/config.yaml` if set
2. The branch the local `origin/HEAD` symbolic ref points to
3. `main`

The squash-merge heuristic SHALL detect a branch as merged when the
branch's tip commit subject appears as the subject of a commit in
the default branch and `git log <branch> ^<default>` produces no
output unique to the branch.

When the default branch cannot be resolved (no config, no
`origin/HEAD`, and the fallback branch does not exist locally),
classification SHALL treat every age-eligible directory as
`unmerged-old`. This is the safe-default-keep degradation.

#### Scenario: Just-under-7d worktree is fresh

- **WHEN** a worktree directory's mtime indicates it is 6 days and
  23 hours old, and there is no failed-run journal entry for it
- **THEN** classification yields `fresh`

#### Scenario: 8d merged worktree is merged-old

- **WHEN** a worktree directory's mtime indicates it is 8 days old,
  no failed-run journal entry exists for it, and the worktree's
  branch is present in `git branch --merged <default>` output
- **THEN** classification yields `merged-old`

#### Scenario: 8d unmerged worktree is unmerged-old

- **WHEN** a worktree directory's mtime indicates it is 8 days old
  and the worktree's branch is not present in
  `git branch --merged <default>` output and the squash-merge
  heuristic does not match
- **THEN** classification yields `unmerged-old`

#### Scenario: Failed run is failed regardless of age

- **WHEN** the failed-run journal has an entry for a worktree
  directory whose `status` is `failed`, regardless of the
  directory's age or branch state
- **THEN** classification yields `failed`

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

### Requirement: Lazy-prune at `minifac run` start

The CLI SHALL perform a millisecond-budgeted prune pass at the
start of every `minifac run` invocation (after argument parsing,
before lock claim). The pass removes every worktree the no-flag
`minifac prune` invocation would have removed (i.e. the
`merged-old` bucket).

The pass SHALL bound its total elapsed time to approximately 200
milliseconds. If the budget is exceeded mid-iteration, the pass
SHALL abort silently (no stderr noise) and rely on explicit
`minifac prune` for deeper cleanup.

The lazy pass MAY skip the expensive squash-merge heuristic to
stay within budget; the cheaper `git branch --merged` check alone
is sufficient for the lazy path.

The lazy pass SHALL NOT modify the failed-run journal, SHALL NOT
delete branches, and SHALL NOT print pruned directory names by
default.

#### Scenario: Lazy pass removes a merged-old directory

- **WHEN** the user invokes `minifac run <brief>` and a worktree
  classified as `merged-old` exists under `worktrees_dir`
- **THEN** the directory is removed before the run's lock claim
  begins, and the run proceeds normally

#### Scenario: Lazy pass aborts on time budget overrun

- **WHEN** classifying directories would take longer than the
  lazy-pass budget (e.g. the worktrees directory holds many
  entries and the merged-check is slow)
- **THEN** the lazy pass aborts before completing, no further
  directories are processed, the run proceeds normally, and no
  warning is emitted to the user

#### Scenario: Lazy pass leaves unmerged-old directories alone

- **WHEN** an `unmerged-old` worktree exists at the start of
  `minifac run`
- **THEN** the lazy pass does not remove it; only explicit
  `minifac prune` flags can remove unmerged-old worktrees

### Requirement: Optional configuration files

minifac SHALL read configuration from two optional YAML files:

- Global: `~/.minifac/config.yaml`
- Per-repo: `<caller-repo-root>/.minifac/config.yaml`

Both files MAY declare:

- `worktrees_dir` (string) — overrides the default
  `~/.minifac/worktrees`
- `locks_dir` (string) — overrides the default `~/.minifac/locks`
  (only honored in the global file)
- `default_branch` (string) — overrides the auto-detected default
  branch used by the prune policy

A missing file SHALL NOT be an error. A file that is unreadable
YAML SHALL exit `1` before any worktree machinery runs, with an
error message naming the offending file and (when available) line
and column.

When both files set the same key, the per-repo file SHALL win for
`worktrees_dir` and `default_branch`. `locks_dir` in the per-repo
file SHALL be ignored (locks are machine-state, not repo-state) and
SHALL NOT raise a validation error.

#### Scenario: Missing config files are not an error

- **WHEN** neither `~/.minifac/config.yaml` nor
  `<repo-root>/.minifac/config.yaml` exists
- **THEN** the CLI uses the documented defaults
  (`~/.minifac/worktrees`, `~/.minifac/locks`) without warning or
  error

#### Scenario: Per-repo `worktrees_dir` wins over global

- **WHEN** the global config declares
  `worktrees_dir: /global/worktrees` and the per-repo config
  declares `worktrees_dir: /repo/worktrees`
- **THEN** worktrees for runs in this repo are created under
  `/repo/worktrees`

#### Scenario: Per-repo `locks_dir` is ignored

- **WHEN** the per-repo config declares
  `locks_dir: /repo/locks` and the global config does not declare
  `locks_dir`
- **THEN** the CLI uses the default `~/.minifac/locks`, the
  per-repo `locks_dir` setting has no effect, and no validation
  error is raised

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

