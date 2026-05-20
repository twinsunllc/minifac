## ADDED Requirements

### Requirement: Worktree directory layout and key derivation

minifac SHALL manage worktrees under a `worktrees_dir` whose default
is `~/.minifac/worktrees/`. Each worktree SHALL live at
`<worktrees_dir>/<key>/` where `<key>` is derived as follows:

- **Brief-driven runs:** `<repo-hash>-<brief.change>`
- **Brief-less factory runs:** `<repo-hash>-<factory.name>-<timestamp>`,
  where `<factory.name>` is the loaded factory object's top-level
  `name` field and `<timestamp>` is `Date.now()` rendered in base-36
  (lexicographically sortable, ≤ 8 chars)

`<repo-hash>` SHALL be the first 8 lowercase hexadecimal characters
of `sha256(repo-identity)`, where `repo-identity` is the trimmed
output of `git config --get remote.origin.url` when non-empty, or
the trimmed output of `git rev-parse --show-toplevel` otherwise.

The directory naming convention is human-browsable: a reader
inspecting `<worktrees_dir>/` SHALL be able to identify a worktree's
change name (or factory-and-timestamp) at a glance.

#### Scenario: Brief-driven worktree path is repo-hash-change

- **WHEN** `minifac run <brief>` is invoked, the brief's `change` is
  `factory-inputs-core`, and the caller's repo has remote
  `git@github.com:foo/bar.git` whose sha256 prefix is `abcd1234`
- **THEN** the resolved worktree path is
  `<worktrees_dir>/abcd1234-factory-inputs-core/`

#### Scenario: Brief-less worktree path includes timestamp

- **WHEN** `minifac run <name>` resolves to a brief-less factory
  invocation, the factory's `name` is `hello`, and the timestamp at
  claim time is `123456789` decimal
- **THEN** the resolved worktree path is
  `<worktrees_dir>/<repo-hash>-hello-<base36(123456789)>/`

#### Scenario: Repo with no remote falls back to absolute path

- **WHEN** `git config --get remote.origin.url` returns empty in the
  caller's repo
- **THEN** the `repo-identity` used to compute `repo-hash` is the
  output of `git rev-parse --show-toplevel`, and the computed hash
  is stable across invocations from that checkout

### Requirement: Worktree creation via git worktree

The CLI SHALL create the worktree by shelling out to
`git -C <caller-cwd> worktree add -b <branch> <worktree-dir>
<base-rev>` where:

- `<branch>` is `brief.change` for brief-driven runs, or
  `<factory.name>-<timestamp>` for brief-less runs (matching the
  worktree key suffix)
- `<base-rev>` is `brief.frontmatter.base_branch` when present; else
  the resolved SHA of the caller's `HEAD` at claim time (resolved
  via `git rev-parse HEAD`)

When `git worktree add` exits non-zero, the CLI SHALL exit `1` with
the git stderr surfaced verbatim, the lock SHALL be released before
exit, and no node SHALL execute.

The created branch SHALL NOT be deleted by minifac at any point
(including on cleanup) — branch lifecycle is the operator's
responsibility.

#### Scenario: Worktree is created at the resolved path

- **WHEN** the CLI claims the lock and invokes `git worktree add`
  with the resolved path, branch name, and base ref
- **THEN** after the command succeeds, the worktree directory exists
  with a working tree checked out on the new branch

#### Scenario: Failure to create worktree releases the lock

- **WHEN** `git worktree add` exits non-zero (e.g. branch already
  exists from a prior run)
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
`<locks_dir>/<key>.lock`, where `<key>` is the same suffix used for
the worktree directory.

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

- **WHEN** process A holds the lock for key `abcd-foo`, A is a
  running PID, and process B attempts to claim the same key
- **THEN** B exits `1` with an error naming A's PID, the key
  `abcd-foo`, and the lockfile path, and B does NOT create a
  worktree

#### Scenario: Different keys run in parallel

- **WHEN** process A holds the lock for `abcd-foo` and process B
  attempts to claim `abcd-bar`
- **THEN** B's claim succeeds and B proceeds to create its own
  worktree under a different directory

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
by `git -C <caller-cwd> worktree prune`. Branches associated with
the removed worktrees SHALL NOT be deleted.

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
