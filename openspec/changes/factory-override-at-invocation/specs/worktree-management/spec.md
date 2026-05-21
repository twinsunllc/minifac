## MODIFIED Requirements

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
