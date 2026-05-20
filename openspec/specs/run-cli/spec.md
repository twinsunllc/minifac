# run-cli Specification

## Purpose
TBD - created by archiving change core-graph-runner. Update Purpose after archive.
## Requirements
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

### Requirement: Event output format

For each node event received, the CLI SHALL write a single line to
stdout (for `stdout` events) or stderr (for `stderr` events), prefixed
with `[<node_id>] ` so multiple nodes' output is legible when
interleaved. `status` events SHALL be written to stderr in a single,
distinct format that names the node and the status.

#### Scenario: Output lines carry node prefix

- **WHEN** node `propose` emits the stdout line "hello"
- **THEN** the terminal shows a line containing `[propose] hello`

#### Scenario: Status events are distinguishable from output

- **WHEN** node `propose` transitions to `succeeded`
- **THEN** stderr receives a line that identifies both the node id and
  the status, distinct in format from `stdout`/`stderr` lines

### Requirement: Exit codes

The CLI SHALL exit with:

- `0` when the run reaches a terminal node with `succeeded`
- `1` for usage errors, file-not-found, or factory load/validation errors
- `2` when a node fails and no recovery path leads to a terminal success
- `3` when budget exhaustion ends the run before reaching a terminal node

#### Scenario: Successful run exits 0

- **WHEN** a factory completes with a successful terminal node
- **THEN** the process exits with code 0

#### Scenario: Schema error exits 1

- **WHEN** the supplied factory fails schema validation
- **THEN** the process writes the validation error to stderr and exits
  with code 1

#### Scenario: Node failure exits 2

- **WHEN** every path from the failing node leads to no further
  schedulable work and no terminal node has succeeded
- **THEN** the process exits with code 2

#### Scenario: Budget exhaustion exits 3

- **WHEN** all cycle budgets are exhausted before a terminal node
  succeeds
- **THEN** the process exits with code 3

### Requirement: `--help` and `--version`

The CLI SHALL respond to `--help` (and `-h`) with a usage summary listing
available subcommands and to `--version` with the package version.

#### Scenario: Help is available without arguments

- **WHEN** the user invokes `minifac --help`
- **THEN** the CLI prints usage to stdout and exits with code 0

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

### Requirement: `minifac brief` subcommand

The CLI SHALL expose a `brief` subcommand that takes a single
positional argument `<name>` and writes a brief file conforming to
the `brief-schema` capability. The subcommand SHALL accept the
following options:

- `--from <file>`: read answers from a YAML or JSON file (detected
  by extension) instead of prompting interactively.
- `--out <path>`: override the default output path. When omitted,
  the brief is written to `inputs/<name>.md` relative to the CLI's
  invocation cwd.
- `--force`: overwrite an existing output file. Without this flag,
  an existing file at the resolved output path is a usage error.

The subcommand SHALL delegate to the `brief-authoring` capability's
question schema and renderer; the on-disk shape SHALL match the
file the capability's renderer would produce for the same answers.

The subcommand SHALL NOT make any HTTP, LLM, or other network call.
It SHALL NOT invoke `git` or write outside the resolved output
path.

#### Interactive mode (default)

When invoked without `--from`, the subcommand SHALL drive an
interactive flow over `process.stdin` / `process.stdout` (or
injected I/O streams in tests). For each question in the
`brief-authoring` capability's schema, in order, the subcommand
SHALL:

- print the question's prompt followed by a newline,
- read one line of input,
- treat an empty line as "no answer" for that question (re-asking
  if the question is required, omitting it if optional),
- accept a sentinel input (`:q` or EOF / SIGINT) as a request to
  stop the flow early.

On normal completion, the subcommand SHALL invoke the renderer,
write the file, invoke `loadBrief` on the written file to verify
round-trip validity, print the absolute path of the written file
to stdout on its own line, and exit `0`.

On early stop, the subcommand SHALL apply the `brief-authoring`
capability's partial-brief behavior (write a file with the
incomplete-marker block when the required frontmatter is complete;
exit non-zero without writing when it is not), print the path of
the written file (if any) and a stderr line naming the
next-unanswered question, and exit `0` (partial) or non-zero
(nothing written).

#### Non-interactive mode (`--from <file>`)

When invoked with `--from <file>`, the subcommand SHALL read the
named file and parse it as YAML (extension `.yaml` or `.yml`) or
JSON (extension `.json`). The parsed value SHALL be an object whose
keys are `AuthoringQuestionId` literals and whose values are
strings. The subcommand SHALL:

- reject unknown keys with a usage error naming the offending key
  and the supported ids,
- reject missing required answers with a usage error naming the
  missing question ids,
- reject non-string values with a usage error naming the offending
  key and its actual type,
- on success, invoke the renderer, write the file, invoke
  `loadBrief` on the written file, print the absolute output path
  to stdout, and exit `0`.

A `--from` file whose extension is neither `.yaml`, `.yml`, nor
`.json` SHALL produce a usage error naming the supported
extensions.

#### TTY requirement

If `--from` is not supplied and `process.stdin` is not a TTY, the
subcommand SHALL exit `1` with a usage error suggesting
`--from <file>`. This prevents the interactive flow from hanging in
non-TTY environments (CI, piped invocations).

#### Scenario: Interactive happy path writes inputs/<name>.md

- **WHEN** the user invokes `minifac brief my-change` interactively and answers each required question with non-empty text
- **THEN** the CLI writes a brief to `inputs/my-change.md`, prints that absolute path to stdout on its own line, invokes `loadBrief` on the file successfully, and exits `0`

#### Scenario: --from happy path

- **WHEN** the user invokes `minifac brief my-change --from answers.yaml` and `answers.yaml` is a YAML object with all required answers
- **THEN** the CLI writes a brief to `inputs/my-change.md`, the produced file matches what the renderer would emit for those answers, the file loads cleanly through `loadBrief`, and the CLI exits `0`

#### Scenario: --out overrides destination

- **WHEN** the user invokes `minifac brief my-change --out /tmp/custom.md --from answers.yaml`
- **THEN** the brief is written to `/tmp/custom.md` and nothing is written under `inputs/`

#### Scenario: Existing file without --force is a usage error

- **WHEN** the user invokes `minifac brief my-change` and `inputs/my-change.md` already exists
- **THEN** the CLI exits `1` writing a stderr message naming the existing file and the `--force` escape hatch; the file is left unchanged

#### Scenario: --force overwrites

- **WHEN** the user invokes `minifac brief my-change --force --from answers.yaml` and `inputs/my-change.md` already exists
- **THEN** the CLI overwrites the file with the new content and exits `0`

#### Scenario: --from rejects unknown keys

- **WHEN** the user invokes `minifac brief my-change --from answers.yaml` and `answers.yaml` contains a top-level key `wat` that is not an `AuthoringQuestionId`
- **THEN** the CLI exits `1` with a stderr message naming `wat` and listing the supported ids

#### Scenario: --from rejects missing required answers

- **WHEN** the user invokes `minifac brief my-change --from answers.yaml` and `answers.yaml` is missing a required answer (e.g. `acceptance_criteria`)
- **THEN** the CLI exits `1` with a stderr message naming the missing required question id

#### Scenario: --from rejects unsupported file extension

- **WHEN** the user invokes `minifac brief my-change --from answers.toml`
- **THEN** the CLI exits `1` with a stderr message naming the supported extensions (`.yaml`, `.yml`, `.json`)

#### Scenario: Interactive stop after required frontmatter writes partial

- **WHEN** the user answers `change` and `factory`, then sends EOF before answering `background`
- **THEN** the CLI writes a partial brief whose body begins with the incomplete-marker block naming `background`, prints the written path to stdout, prints a stderr line naming the next-unanswered question, and exits `0`

#### Scenario: Interactive stop before required frontmatter writes nothing

- **WHEN** the user sends EOF before answering `change`
- **THEN** the CLI writes no file, prints a stderr message naming the missing required frontmatter, and exits non-zero

#### Scenario: Non-TTY without --from is a usage error

- **WHEN** the user invokes `minifac brief my-change` with `process.stdin` not a TTY and no `--from` flag
- **THEN** the CLI exits `1` with a stderr message suggesting `--from <file>`

#### Scenario: Subcommand does not invoke external services

- **WHEN** the user invokes `minifac brief my-change` (interactive or `--from`) on a machine with no network
- **THEN** the CLI runs to completion without attempting any HTTP, LLM, or other network call

