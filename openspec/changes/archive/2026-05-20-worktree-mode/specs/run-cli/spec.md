## MODIFIED Requirements

### Requirement: `minifac run` command

The CLI SHALL expose a `run` subcommand that takes a single positional
argument `<thing>` and an optional `--in-place` flag. The CLI SHALL
resolve `<thing>` to a brief, a factory, or an error using the
following lookup precedence, evaluated in order against the directory
the CLI was invoked from (cwd):

1. **Brief by path.** If `<thing>` contains a path separator OR ends
   in `.md`, treat `<thing>` as a brief path. Resolve relative paths
   against cwd, absolute paths verbatim. If the file does not exist,
   exit `1` with an error naming the resolved path.
2. **Brief by name.** Else, if `inputs/<thing>.md` exists in cwd, treat
   it as a brief by name and load it via that path.
3. **Factory by name.** Else, if `examples/<thing>.yaml` exists in
   cwd, treat the run as a brief-less factory invocation of that
   factory. (The `examples/` prefix is a v0 stopgap until
   factory-composition ships per the roadmap.)
4. **Else.** Write an error to stderr explaining that `<thing>` could
   not be resolved as a brief path, brief name, or factory name and
   exit `1`.

When a brief is resolved (steps 1 or 2), the CLI SHALL further resolve
the brief's frontmatter `factory:` field as a factory name using the
same step-3 logic (try `examples/<factory>.yaml`). A brief whose
`factory:` field does not resolve SHALL exit `1` with an error naming
the missing factory.

The CLI SHALL enforce the factory's declared brief mode (per the
`factory-schema` capability's "Factory brief-mode declaration"
requirement) before any node executes:

- `brief: "required"` invoked without a brief (step 3 resolution) →
  exit `1` with a message naming the factory and instructing the user
  to invoke with a brief.
- `brief: "none"` invoked with a brief (step 1 or 2 resolution) →
  exit `1` with a message naming the factory and the conflict.
- `brief: "optional"` → accept either invocation mode.

Direct invocation by factory YAML path (e.g. `minifac run
examples/sdd.yaml`) SHALL NOT be supported. A `.yaml` or `.yml`
extension on `<thing>` falls into step 1 (treated as a brief path),
which will fail to parse as a brief; the CLI SHALL exit `1` with the
brief-load error in that case, surfacing the misuse directly.

After resolution succeeds, and before any node executes, the CLI
SHALL sequence the run as follows:

1. Determine **mode**: `in-place` if `--in-place` is supplied OR (a
   brief is resolved AND its frontmatter declares
   `mode: "in-place"`); otherwise `worktree`.
2. Load worktree-management configuration (per the
   `worktree-management` capability's "Optional configuration files"
   requirement).
3. If mode is `worktree`, run the lazy-prune pass (per the
   `worktree-management` capability's "Lazy-prune at `minifac run`
   start" requirement).
4. Claim the per-key lockfile (per the `worktree-management`
   capability's "Per-key lockfile with PID-bearing claim"
   requirement). The lock key is `<repo-hash>-<change>` for
   brief-driven runs, or `<repo-hash>-<factory.name>-<timestamp>` for
   brief-less factory runs.
5. If mode is `worktree`, create the worktree via
   `git worktree add` (per the `worktree-management` capability's
   "Worktree creation via git worktree" requirement). Set the run's
   `runCwd` to the resolved worktree path.
6. If mode is `in-place`, skip worktree creation. Set the run's
   `runCwd` to `process.cwd()`.
7. Invoke the runner, passing `runCwd` (per the `graph-runner`
   capability's "Run-level cwd resolution" requirement) and the
   brief (when resolved).
8. On any run termination (success or failure), in a `try/finally`:
   - If the terminal status is not `succeeded`, append a journal
     entry per the `worktree-management` capability's "Failed-run
     journal" requirement.
   - Release the lockfile.
   - Emit a single final stderr line that names the run's
     `runCwd` (the worktree path or the in-place cwd) and the
     terminal run status, so the operator knows where the work
     landed.

The runner streams node events to the terminal per the existing
event-output requirement, which is unchanged by this revision. The
final stderr summary line is in addition to the existing per-event
output, not a replacement for it.

#### Scenario: Brief by path loads and runs

- **WHEN** the user invokes `minifac run inputs/foo.md` and that file
  is a valid brief whose `factory:` resolves to `examples/sdd.yaml`
- **THEN** the CLI loads the brief, loads `examples/sdd.yaml`, claims
  a lock, creates a worktree, and runs the factory with the brief in
  scope and `runCwd` set to the worktree path; streaming output
  begins before the process exits

#### Scenario: Brief by bare name resolves via inputs/<name>.md

- **WHEN** the user invokes `minifac run my-change` and
  `inputs/my-change.md` exists as a valid brief
- **THEN** the CLI loads that brief, resolves its factory by name,
  claims a lock, creates a worktree, and runs the factory with the
  brief in scope and `runCwd` set to the worktree path

#### Scenario: Factory by bare name runs brief-less

- **WHEN** the user invokes `minifac run hello`,
  `inputs/hello.md` does not exist, `examples/hello.yaml` exists, and
  `examples/hello.yaml` declares `brief: "none"`
- **THEN** the CLI loads `examples/hello.yaml`, claims a lock keyed
  on `<repo-hash>-hello-<timestamp>`, creates a worktree at that
  same key, and runs the factory with `runCwd` set to the worktree
  path; streaming output begins before the process exits

#### Scenario: Brief takes precedence over a same-named factory

- **WHEN** both `inputs/sdd.md` and `examples/sdd.yaml` exist and the
  user invokes `minifac run sdd`
- **THEN** the CLI loads `inputs/sdd.md` (step 2) and ignores
  `examples/sdd.yaml` at the top-level lookup; the factory is then
  resolved through the brief's `factory:` field

#### Scenario: Brief-required factory invoked brief-less is rejected

- **WHEN** the user invokes `minifac run sdd`, `inputs/sdd.md` does
  not exist, and `examples/sdd.yaml` declares `brief: "required"`
- **THEN** the CLI exits `1` writing an error that names the factory
  and indicates a brief is required; no worktree is created, no
  lock is claimed, and no node executes

#### Scenario: Brief-none factory invoked with a brief is rejected

- **WHEN** the user invokes `minifac run hello-brief` and
  `inputs/hello-brief.md` is a brief whose `factory:` resolves to
  `examples/hello.yaml`, which declares `brief: "none"`
- **THEN** the CLI exits `1` writing an error naming the factory and
  the conflict; no worktree is created, no lock is claimed, and no
  node executes

#### Scenario: Direct factory-YAML path is no longer supported

- **WHEN** the user invokes `minifac run examples/sdd.yaml`
- **THEN** the CLI treats the argument as a brief path (step 1), fails
  to parse it as a brief, and exits `1` with the brief-load error

#### Scenario: Missing thing reports a clear resolution error

- **WHEN** the user invokes `minifac run nonexistent` and none of
  `nonexistent`, `inputs/nonexistent.md`, or `examples/nonexistent.yaml`
  resolves
- **THEN** the CLI writes an error to stderr explaining that
  `nonexistent` could not be resolved as a brief path, brief name, or
  factory name, and exits `1`

#### Scenario: Brief whose factory does not resolve is rejected

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief
  loads cleanly, its `factory:` field is `nonexistent`, and
  `examples/nonexistent.yaml` does not exist
- **THEN** the CLI exits `1` with an error naming the missing factory

#### Scenario: --in-place skips worktree creation

- **WHEN** the user invokes `minifac run inputs/foo.md --in-place`
- **THEN** the CLI claims a lock per the worktree-management
  contract, does NOT invoke `git worktree add`, does NOT create
  any directory under `worktrees_dir`, sets `runCwd` to
  `process.cwd()`, and proceeds with the run

#### Scenario: Brief mode: in-place sets in-place mode

- **WHEN** the user invokes `minifac run inputs/foo.md` (no
  `--in-place` flag) and `inputs/foo.md`'s frontmatter declares
  `mode: in-place`
- **THEN** the CLI treats the run as in-place: a lock is claimed,
  no worktree is created, and `runCwd` is `process.cwd()`

#### Scenario: Final stderr summary names runCwd and status

- **WHEN** a run terminates (succeeded or failed)
- **THEN** the CLI's final stderr line names the run's `runCwd`
  (worktree path or in-place cwd) and the terminal run status

#### Scenario: Failed worktree run appends to journal

- **WHEN** a worktree-mode run terminates with status `failed`
- **THEN** an entry is appended to `~/.minifac/failed-runs.json`
  whose `worktreeDir` is the worktree path of this run and whose
  `status` is `failed`

#### Scenario: Failed in-place run appends to journal

- **WHEN** an in-place run terminates with status `failed`
- **THEN** an entry is appended to `~/.minifac/failed-runs.json`
  whose `worktreeDir` is `process.cwd()` at run time and whose
  `status` is `failed`

## ADDED Requirements

### Requirement: `minifac prune` subcommand

The CLI SHALL expose a `prune` subcommand that delegates to the
`worktree-management` capability's hybrid policy and flag matrix
(see that capability's "`minifac prune` subcommand flag matrix"
requirement). The subcommand SHALL accept the flags `--all`,
`--merged`, `--older-than <duration>`, and `--failed`, in any
combination.

The subcommand SHALL NOT require a brief or a factory. It operates
purely on the `worktrees_dir` and the failed-run journal.

The subcommand SHALL exit `0` on successful processing (including
when zero directories are removed). It SHALL exit `1` only on
usage errors (e.g. unparseable `--older-than` duration) or on a
fatal I/O error while scanning `worktrees_dir`.

When a worktree directory cannot be removed (e.g. permission error,
in-use lock file inside), the subcommand SHALL surface the per-
directory failure on stderr and SHALL continue processing the
remaining directories; it SHALL NOT abort on first failure.

#### Scenario: Prune with no flags removes only merged-old

- **WHEN** the user invokes `minifac prune` and the worktrees
  directory contains one of each classification bucket (`fresh`,
  `merged-old`, `unmerged-old`, `failed`)
- **THEN** only the `merged-old` directory is removed; the CLI
  exits `0`; stdout contains a one-line summary naming the
  removed-per-bucket counts

#### Scenario: Prune surfaces per-directory removal failure

- **WHEN** `minifac prune` selects two directories for removal
  and the `git worktree remove --force` invocation for the first
  exits non-zero AND the `rm -rf` fallback also fails (e.g.
  permission denied)
- **THEN** the CLI writes a stderr line naming the failed
  directory and the underlying error, continues to process the
  second directory, and exits `0` (the run as a whole succeeded
  modulo the noted failure)

#### Scenario: Unparseable --older-than is a usage error

- **WHEN** the user invokes `minifac prune --older-than nonsense`
- **THEN** the CLI writes a usage error to stderr explaining the
  duration syntax (`<int><m|h|d>`) and exits `1`; no directories
  are touched
