# run-cli Specification

## Purpose
TBD - created by archiving change core-graph-runner. Update Purpose after archive.
## Requirements
### Requirement: `minifac run` command

The CLI SHALL expose a `run` subcommand that takes a single positional
argument `<thing>`, an optional `--in-place` flag, an optional
`--force` flag, and an optional `--factory <name>` flag. The CLI
SHALL resolve `<thing>` to a brief, a factory, or an error using the
following lookup precedence, evaluated in order against the directory
the CLI was invoked from (cwd):

1. **Brief by path.** If `<thing>` contains a path separator OR ends
   in `.md`, treat `<thing>` as a brief path. Resolve relative paths
   against cwd, absolute paths verbatim. If the file does not exist,
   exit `1` with an error naming the resolved path.
2. **Brief by name.** Else, if `inputs/<thing>.md` exists in cwd, treat
   it as a brief by name and load it via that path.
3. **Factory by name.** Else, treat the run as a brief-less factory
   invocation. Resolve `<thing>` as a factory name using the two-step
   precedence defined below; if neither candidate exists, fall
   through to step 4.
4. **Else.** Write an error to stderr explaining that `<thing>` could
   not be resolved as a brief path, brief name, or factory name and
   exit `1`.

**Factory-by-name resolution** (used by step 3 above, by the brief's
`factory:` field when the brief is loaded via step 1 or 2, AND by
the `--factory <name>` flag value when supplied) SHALL accept two
forms:

- `minifac:<name>` — the `minifac:` prefix SHALL skip the local
  lookup and resolve directly to `<cwd>/examples/<name>.yaml`. For
  v0, "built-in" means "in `examples/` of the calling repo"; a
  future packaging change MAY relocate built-ins without changing
  this brief syntax.
- `<name>` (no prefix) — try `<cwd>/.minifac/factories/<name>.yaml`
  first; if that path does not exist, fall back to
  `<cwd>/examples/<name>.yaml`. A `<name>` lookup succeeds at
  whichever path exists; if neither exists, factory-by-name
  resolution fails.

A brief whose `factory:` field uses the `minifac:` prefix SHALL
resolve directly to the built-in even when an equally-named
`.minifac/factories/<name>.yaml` exists. A brief whose `factory:`
field is a bare `<name>` SHALL prefer the local file when present.
The same precedence applies to the `--factory` flag value.

When a brief is resolved (steps 1 or 2), the CLI SHALL further
resolve the brief's frontmatter `factory:` field using the same
factory-by-name resolution above. A brief whose `factory:` field
does not resolve to any candidate path SHALL exit `1` with an error
naming the missing factory (and, for the bare `<name>` form, naming
both paths tried).

**`--factory <name>` override.** When `--factory <name>` is
supplied (steps 1 or 2 — i.e. a brief-driven invocation), the flag
value SHALL replace the brief's `factory:` field for this
invocation. The brief file SHALL NOT be modified. The flag value
SHALL be resolved through the same factory-by-name resolution
above and SHALL be subject to the same error contract: a flag
value that does not resolve to any candidate path SHALL exit `1`
with an error naming the unresolved value and (for the bare form)
both paths tried. The override SHALL take effect *before* the
factory's `brief:` mode is enforced and before the lockfile key is
derived. When `--factory` is not supplied, behavior is unchanged
from the brief's declared factory. The `--factory` flag on a
brief-less factory invocation (step 3) SHALL be a usage error
(exit `1`) with a stderr message naming the conflict
("--factory is only meaningful with a brief; <thing> resolved as
a factory invocation"), since brief-less runs already name the
factory positionally.

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

When a brief is resolved (steps 1 or 2), the CLI SHALL — before any
worktree creation, lockfile claim, or node execution — compute the
brief's state via the `brief-state` capability's "Combined brief
state and dep satisfaction" requirement. If the computed state is
`blocked` and `--force` was NOT supplied, the CLI SHALL exit `1`
with a stderr message naming each unsatisfied dep and its current
doneness. If the computed state is `blocked` and `--force` WAS
supplied, the CLI SHALL emit a single stderr warning line naming
the overridden deps and proceed. If `computeBriefState` throws a
cycle error, the CLI SHALL exit `1` with a stderr message naming
the full cycle regardless of `--force`.

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
   requirement). The lock key SHALL be derived as follows:
   - For brief-driven runs:
     `<repo-hash>-<change>-<factory-name>`, where `<factory-name>`
     is the loaded factory's top-level `name` field (which reflects
     the `--factory` override when supplied, else the brief's
     declared factory).
   - For brief-less factory runs:
     `<repo-hash>-<factory-name>-<timestamp>` (unchanged).
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

The factory actually used for the run (overridden or default)
SHALL be recorded in the persisted run row's `factoryName` and
`factoryPath` columns (per the `run-storage` capability), so
listings (`minifac runs --change <change>`) accurately reflect
which factory produced which branch.

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
  `nonexistent`, `inputs/nonexistent.md`,
  `.minifac/factories/nonexistent.yaml`, or
  `examples/nonexistent.yaml` resolves
- **THEN** the CLI writes an error to stderr explaining that
  `nonexistent` could not be resolved as a brief path, brief name, or
  factory name, and exits `1`

#### Scenario: Brief whose factory does not resolve is rejected

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief
  loads cleanly, its `factory:` field is `nonexistent`, and neither
  `.minifac/factories/nonexistent.yaml` nor
  `examples/nonexistent.yaml` exists
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

#### Scenario: Brief's bare `factory:` prefers local custom over built-in

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief's
  frontmatter declares `factory: sdd`, and both
  `.minifac/factories/sdd.yaml` and `examples/sdd.yaml` exist
- **THEN** the CLI loads `.minifac/factories/sdd.yaml` (the local
  custom factory), not `examples/sdd.yaml`

#### Scenario: Brief's bare `factory:` falls back to built-in when no local exists

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief's
  frontmatter declares `factory: sdd`,
  `.minifac/factories/sdd.yaml` does not exist, and
  `examples/sdd.yaml` exists
- **THEN** the CLI loads `examples/sdd.yaml`

#### Scenario: Brief's `minifac:<name>` prefix skips local lookup

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief's
  frontmatter declares `factory: minifac:sdd`, and both
  `.minifac/factories/sdd.yaml` and `examples/sdd.yaml` exist
- **THEN** the CLI loads `examples/sdd.yaml` (the built-in),
  ignoring the local file

#### Scenario: Brief's `minifac:<name>` with no matching built-in fails

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief's
  frontmatter declares `factory: minifac:nonexistent`, and
  `examples/nonexistent.yaml` does not exist
- **THEN** the CLI exits `1` with an error naming
  `minifac:nonexistent` and the absolute path tried, even if a
  `.minifac/factories/nonexistent.yaml` happens to exist

#### Scenario: Brief-less factory by name resolves from local first

- **WHEN** the user invokes `minifac run sdd-fast`,
  `inputs/sdd-fast.md` does not exist, and
  `.minifac/factories/sdd-fast.yaml` exists
- **THEN** the CLI loads `.minifac/factories/sdd-fast.yaml` as a
  brief-less factory invocation; `examples/sdd-fast.yaml` (if any)
  is not consulted

#### Scenario: Blocked brief is refused before worktree creation

- **WHEN** the user invokes `minifac run foo`, `inputs/foo.md`
  declares `depends_on: [bar]`, and `inputs/bar.md` exists
  (so `bar` is active, not done)
- **THEN** the CLI exits `1` with a stderr message naming `bar`
  and its current doneness (`active`); no lockfile is claimed,
  no worktree is created, and no node executes

#### Scenario: Missing dep is refused before worktree creation

- **WHEN** the user invokes `minifac run foo`, `inputs/foo.md`
  declares `depends_on: [bar]`, and neither `inputs/bar.md` nor
  `inputs/done/bar.md` exists
- **THEN** the CLI exits `1` with a stderr message naming `bar`
  and the doneness `missing`; no worktree is created

#### Scenario: Satisfied deps proceed normally

- **WHEN** the user invokes `minifac run foo`, `inputs/foo.md`
  declares `depends_on: [bar]`, and `inputs/done/bar.md` exists
- **THEN** the CLI proceeds with normal `run` sequencing (lock,
  worktree, runner) as if `depends_on` were empty

#### Scenario: --force overrides a blocked brief

- **WHEN** the user invokes `minifac run foo --force`,
  `inputs/foo.md` declares `depends_on: [bar]`, and `bar` is not
  done
- **THEN** the CLI writes a single stderr warning naming the
  overridden deps and proceeds with the run (lock, worktree,
  runner)

#### Scenario: Dependency cycle is refused even with --force

- **WHEN** the user invokes `minifac run foo` (with or without
  `--force`), `inputs/foo.md` declares `depends_on: [bar]`, and
  `inputs/bar.md` declares `depends_on: [foo]`
- **THEN** the CLI exits `1` with a stderr message naming the full
  cycle (`foo -> bar -> foo`); no worktree is created and no node
  executes

#### Scenario: --factory override replaces the brief's declared factory

- **WHEN** the user invokes `minifac run foo --factory bar`,
  `inputs/foo.md` declares `factory: sdd`, and
  `examples/bar.yaml` exists (no `.minifac/factories/bar.yaml`)
- **THEN** the CLI loads `examples/bar.yaml` (not
  `examples/sdd.yaml`), the persisted run row's `factoryName` is
  `bar`, and `inputs/foo.md` is unchanged on disk

#### Scenario: --factory with `minifac:` prefix forces built-in

- **WHEN** the user invokes `minifac run foo --factory minifac:sdd`,
  both `.minifac/factories/sdd.yaml` and `examples/sdd.yaml` exist
- **THEN** the CLI loads `examples/sdd.yaml`, ignoring the local
  file; the run row's `factoryName` is `sdd` and `factoryPath`
  resolves to the built-in

#### Scenario: --factory with unknown name is rejected

- **WHEN** the user invokes `minifac run foo --factory nonexistent`
  and neither `.minifac/factories/nonexistent.yaml` nor
  `examples/nonexistent.yaml` exists
- **THEN** the CLI exits `1` with a stderr message naming
  `nonexistent` and both paths tried (matching the error shape
  produced when a brief's `factory:` field cannot be resolved); no
  worktree is created, no lock is claimed

#### Scenario: --factory with `minifac:<name>` and no built-in is rejected

- **WHEN** the user invokes `minifac run foo
  --factory minifac:nonexistent` and `examples/nonexistent.yaml`
  does not exist
- **THEN** the CLI exits `1` with a stderr message naming
  `minifac:nonexistent` and the single built-in path tried; the
  local `.minifac/factories/nonexistent.yaml` (if any) is not
  consulted

#### Scenario: --factory on a brief-less invocation is a usage error

- **WHEN** the user invokes `minifac run hello --factory sdd`,
  `inputs/hello.md` does not exist, `examples/hello.yaml` exists,
  and the invocation would otherwise resolve as a brief-less
  factory run
- **THEN** the CLI exits `1` with a stderr message naming the
  conflict (`--factory` is only meaningful with a brief); no
  worktree is created, no lock is claimed

#### Scenario: --factory absent leaves brief behavior unchanged

- **WHEN** the user invokes `minifac run foo` with no `--factory`
  flag and `inputs/foo.md` declares `factory: sdd`
- **THEN** the CLI resolves the factory through the brief's
  declared value (existing behavior); the persisted run row's
  `factoryName` is `sdd`

#### Scenario: Two concurrent runs of same brief through different factories proceed in parallel

- **WHEN** the user invokes `minifac run foo --factory A` in one
  shell and `minifac run foo --factory B` in another (both at
  roughly the same time)
- **THEN** both invocations claim distinct lockfiles
  (`<repo-hash>-foo-A.lock` and `<repo-hash>-foo-B.lock`), both
  create distinct worktrees on distinct branches per
  `[[0019-Run-Scoped-Branches]]`, and both runs proceed
  concurrently; both runs are persisted to `runs.db` with
  `factoryName` reflecting their respective overrides

#### Scenario: Two concurrent runs of same brief through same factory serialize

- **WHEN** the user invokes `minifac run foo --factory A` in two
  shells at the same time (or one with `--factory A` and one with
  no flag whose brief declares `factory: A`)
- **THEN** exactly one invocation claims the lockfile
  `<repo-hash>-foo-A.lock`; the other exits `1` with the existing
  "lock held by PID <p>" stderr message; no second worktree is
  created

### Requirement: Event output format

The CLI's `run` subcommand SHALL emit node events in one of two
output modes, chosen at startup:

- **Raw mode**: for each node event received, the CLI SHALL write
  a single line to stdout (for `stdout` events) or stderr (for
  `stderr` events), prefixed with `[<node_id>] ` so multiple
  nodes' output is legible when interleaved. `status` events
  SHALL be written to stderr in a single, distinct format that
  names the node and the status.
- **TUI mode**: the CLI SHALL drive an interactive terminal user
  interface that consumes the same `onEvent` stream and renders
  it per the `run-tui` capability (layout, status pane, log pane,
  hotkey contract, log-rendering rules, completion behavior).

Mode selection SHALL follow this precedence, evaluated in order:

1. `--raw` flag → raw mode (force, even on a TTY).
2. `--tui` flag → TUI mode (force, even on a non-TTY; useful for
   tests).
3. Else, if `process.stdout.isTTY` is truthy → TUI mode (the
   default for interactive invocations).
4. Else → raw mode (the default for pipes, redirects, and CI).

`--raw` and `--tui` SHALL be mutually exclusive; supplying both
SHALL be a usage error (exit `1`) with a stderr message naming
the conflict.

In both modes, the run subcommand SHALL preserve the final
stderr summary line `[run] <status> cwd=<path>` already
documented by the `minifac run` command requirement. In TUI
mode, the summary SHALL be emitted after the TUI has unmounted
the terminal (i.e. after the user presses `q`), so scripts that
grep for `[run]` in stderr keep working when stderr is piped
even with `--tui` forced.

The auto-fallback rule (step 3 → step 4) ensures CI pipelines
and `minifac run foo > log` invocations keep producing today's
line-oriented output without any flag changes.

#### Scenario: Output lines carry node prefix

- **WHEN** node `propose` emits the stdout line "hello" and the
  subcommand is in raw mode
- **THEN** the terminal shows a line containing `[propose] hello`

#### Scenario: Status events are distinguishable from output

- **WHEN** node `propose` transitions to `succeeded` in raw mode
- **THEN** stderr receives a line that identifies both the node id
  and the status, distinct in format from `stdout`/`stderr` lines

#### Scenario: Interactive invocation defaults to TUI

- **WHEN** the user invokes `minifac run <brief>` from a terminal
  where `process.stdout.isTTY` is truthy and neither `--raw` nor
  `--tui` is supplied
- **THEN** the CLI renders the TUI per the `run-tui` capability;
  raw line-prefixed stream events are NOT written to stdout
  while the TUI is mounted

#### Scenario: Non-TTY invocation falls back to raw

- **WHEN** the user invokes `minifac run <brief> > log` (or any
  invocation where `process.stdout.isTTY` is not truthy) and
  neither `--raw` nor `--tui` is supplied
- **THEN** the CLI writes today's line-prefixed stream events to
  stdout/stderr unchanged; no TUI is mounted

#### Scenario: --raw forces raw mode in a TTY

- **WHEN** the user invokes `minifac run <brief> --raw` in a
  terminal where `process.stdout.isTTY` is truthy
- **THEN** the CLI emits raw line-prefixed events and does NOT
  mount the TUI

#### Scenario: --tui forces TUI mode in a non-TTY

- **WHEN** the user invokes `minifac run <brief> --tui` with a
  stdout that is not a TTY (e.g. piped or redirected, used by
  tests)
- **THEN** the CLI mounts the TUI and renders into the non-TTY
  surface (snapshotted by tests via ink's testing utilities);
  raw line-prefixed events are NOT written to stdout

#### Scenario: --raw and --tui together is a usage error

- **WHEN** the user invokes `minifac run <brief> --raw --tui`
- **THEN** the CLI exits `1` with a stderr message naming the
  flag conflict; no run is started

#### Scenario: Final [run] stderr summary line is preserved in both modes

- **WHEN** a run terminates in either raw mode or TUI mode (the
  latter after the user presses `q`)
- **THEN** the CLI emits the existing `[run] <status>
  cwd=<path>` line to stderr exactly once

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
`--merged`, `--older-than <duration>`, `--failed`, and `--outputs`,
in any combination.

The subcommand SHALL NOT require a brief or a factory. It operates
purely on the `worktrees_dir`, the failed-run journal, and (when
`--outputs` is supplied) on the per-run output directory tree
plus `runs.db`.

By default (without `--outputs`), the subcommand behaves as
documented today: it processes the worktree directory only. The
`--outputs` flag is purely additive — it does not alter worktree
classification or removal behavior, and it does not require
`--outputs` to be supplied alongside any other flag.

When `--outputs` is supplied, the subcommand SHALL additionally
process the `${MINIFAC_HOME}/outputs/` tree, applying the same
hybrid classification policy used for worktrees:

- **Source of truth for run status:** `runs.db`. A run whose
  stored status is `running` is NEVER eligible for pruning
  regardless of any other classification (matches today's
  worktree policy of never pruning fresh-in-progress dirs).
- **Source of truth for age:** the filesystem `mtime` of the
  per-run outputs directory (`${MINIFAC_HOME}/outputs/<run-id>/`).
- **Classification buckets:** mirroring the worktree buckets,
  the subcommand SHALL classify each per-run outputs directory
  into `merged-old`, `unmerged-old`, `fresh`, or `failed` using
  the same age-and-status rules.
- **Default invocation (no other flags):** remove every
  `merged-old` outputs directory; keep all others.
- **`--all`:** add `unmerged-old` and `fresh` outputs
  directories; `failed` remains excluded unless `--failed` is
  also supplied.
- **`--failed`:** ALSO remove `failed` outputs directories.
- **`--older-than <duration>`:** overrides the default 7-day
  age cutoff for outputs classification, identically to its
  effect on worktree classification.

For every per-run outputs directory selected for removal, the
subcommand SHALL `rm -rf <dir>` and DELETE the corresponding rows
from `node_outputs` (filtered by `run_id`). The `runs`,
`events`, and `node_executions` rows for the run SHALL be
preserved (the run's event log remains queryable after its
outputs are reclaimed).

After processing, the CLI SHALL write a one-line summary to
stdout naming the removed-per-bucket counts for worktrees AND
(when `--outputs` was supplied) for outputs directories. The two
counts SHALL be reported separately so the operator can tell
which side of the prune did work.

The subcommand SHALL exit `0` on successful processing (including
when zero directories are removed). It SHALL exit `1` only on
usage errors (e.g. unparseable `--older-than` duration) or on a
fatal I/O error while scanning `worktrees_dir` or
`${MINIFAC_HOME}/outputs/`.

When a worktree directory cannot be removed (e.g. permission error,
in-use lock file inside), the subcommand SHALL surface the per-
directory failure on stderr and SHALL continue processing the
remaining directories; it SHALL NOT abort on first failure. The
same rule applies to outputs directories when `--outputs` is
supplied.

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

#### Scenario: `--outputs` removes merged-old outputs directories

- **WHEN** the user invokes `minifac prune --outputs` and the
  outputs tree contains per-run directories classified as
  `fresh`, `merged-old`, `unmerged-old`, and `failed`
- **THEN** only the `merged-old` outputs directory is removed
  (mirroring the worktree default); the `node_outputs` rows for
  the removed run id are DELETEd from `runs.db`; the run's
  `runs` / `events` / `node_executions` rows are preserved; the
  CLI exits `0`; the summary line names the removed-outputs
  count separately from the removed-worktrees count

#### Scenario: `--outputs --all --failed` reclaims everything

- **WHEN** the user invokes `minifac prune --outputs --all --failed`
- **THEN** every per-run outputs directory regardless of bucket
  is removed and its `node_outputs` rows are DELETEd; the
  worktree side of the prune behaves per its own flag
  semantics; the CLI exits `0`

#### Scenario: `--outputs` never touches running runs

- **WHEN** the user invokes `minifac prune --outputs --all --failed`
  and a run is currently `running` in `runs.db` with an
  outputs directory on disk
- **THEN** the running run's outputs directory is NOT removed;
  its `node_outputs` rows are preserved; only terminated runs'
  outputs directories are eligible for reclamation

#### Scenario: `--outputs --older-than` overrides the age cutoff

- **WHEN** the user invokes `minifac prune --outputs --older-than 30d`
  and an outputs directory is 10 days old for a `merged`
  (succeeded) run
- **THEN** classification treats that directory as `fresh`
  (10d < 30d) and it is NOT removed

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

### Requirement: `minifac init` subcommand

The CLI SHALL expose an `init` subcommand that bootstraps the
minifac directory layout in the directory the CLI was invoked from
(cwd). The subcommand SHALL:

- Create `inputs/` if it does not exist.
- Create `.minifac/` if it does not exist.
- Create `.minifac/factories/` if it does not exist, populating it
  with a small README file (e.g. `.minifac/factories/README.md`)
  that explains the convention: each file is a custom or extended
  factory referenced by name from a brief.

The subcommand SHALL be idempotent: re-running it on a repo that
already has any subset of the above SHALL fill in only the missing
pieces without error and SHALL NOT overwrite files that already
exist.

The subcommand SHALL accept an optional `--with-sdd` flag. When
supplied, the subcommand SHALL additionally write a starter file at
`.minifac/factories/sdd.yaml` containing `extends: "minifac:sdd"`
and no other overrides (so the user has a template to edit). If
`.minifac/factories/sdd.yaml` already exists, the `--with-sdd` flag
SHALL be a no-op for that file (it SHALL NOT overwrite the existing
content) and the subcommand SHALL still exit `0`.

The subcommand SHALL NOT make any network call, SHALL NOT invoke
`git`, and SHALL NOT touch any files outside the listed paths.

The subcommand SHALL exit `0` on success (including on no-op
re-runs) and SHALL write a brief one-line summary of what was
created (or "already initialized" when nothing changed) to stdout.

The subcommand SHALL exit `1` on a fatal I/O error (e.g. permission
denied on the target directory), with a stderr message naming the
offending path and the underlying error.

#### Scenario: Init on an empty repo creates the layout

- **WHEN** the user invokes `minifac init` in a directory with
  neither `inputs/` nor `.minifac/`
- **THEN** the CLI creates `inputs/`, `.minifac/`, and
  `.minifac/factories/` (with a README file inside the factories
  directory), writes a one-line summary to stdout, and exits `0`

#### Scenario: Init is idempotent

- **WHEN** the user invokes `minifac init` twice in a row in the
  same directory
- **THEN** the second invocation creates no new files, leaves
  existing files untouched, writes a one-line "already initialized"
  (or equivalent) summary to stdout, and exits `0`

#### Scenario: Init fills in only missing pieces

- **WHEN** the user invokes `minifac init` in a directory where
  `inputs/` already exists but `.minifac/` does not
- **THEN** the CLI creates `.minifac/` and `.minifac/factories/`
  (with the README), leaves the existing `inputs/` directory
  untouched, and exits `0`

#### Scenario: --with-sdd writes a starter factory

- **WHEN** the user invokes `minifac init --with-sdd` and
  `.minifac/factories/sdd.yaml` does not exist
- **THEN** the CLI creates the directory layout and additionally
  writes `.minifac/factories/sdd.yaml` containing
  `extends: "minifac:sdd"` (and no other overrides), and exits `0`

#### Scenario: --with-sdd does not overwrite an existing sdd.yaml

- **WHEN** the user invokes `minifac init --with-sdd` and
  `.minifac/factories/sdd.yaml` already exists with custom content
- **THEN** the CLI does not modify the existing file, writes a
  stdout line noting the file was preserved, and exits `0`

#### Scenario: Init does not invoke external services

- **WHEN** the user invokes `minifac init` on a machine with no
  network
- **THEN** the CLI runs to completion without attempting any HTTP,
  LLM, or `git` call

#### Scenario: Init reports a fatal I/O error clearly

- **WHEN** the user invokes `minifac init` in a directory where
  the process lacks write permission
- **THEN** the CLI exits `1` with a stderr message naming the
  unwritable path and the underlying error

### Requirement: `minifac runs` subcommand

The CLI SHALL expose a `runs` subcommand that lists persisted
runs from the `run-storage` capability's store. The subcommand
SHALL accept the following options:

- `--factory <name>` — filter runs by factory name (matched
  against the run's stored `factoryName`).
- `--change <name>` — filter runs by brief change (matched
  against the run's stored `change`).
- `--status <s>` — filter runs by status, where `s` is one of
  `running`, `succeeded`, or `failed`. Any other value SHALL
  be a usage error.
- `--limit <n>` — cap the number of runs returned. SHALL be a
  positive integer; default `20`.
- `--json` — emit the run list as a JSON array on stdout
  (suitable for piping). The JSON SHALL be one array of
  objects, each carrying at minimum `id`, `factoryName`,
  `change`, `status`, `startedAt`, `endedAt`, and
  `branchName`.

Default output (no `--json`) SHALL be a compact human-readable
table with at least the columns id (short prefix is acceptable
when the prefix is unambiguous), change (or factory when the
run is brief-less), status, started-at (local time), duration
(when terminal), and `branchName` (rendered as the empty string
when the row's stored value is `null`). The branch column MAY
be abbreviated for table-width reasons (e.g. the slug suffix
alone) so long as the full value is available in `--json`. Runs
SHALL be sorted by `startedAt` descending so the most recent
runs are first.

The subcommand SHALL NOT mutate the store. The subcommand SHALL
NOT invoke any external service. The subcommand SHALL exit `0`
on success (including when zero runs match) and `1` on a usage
error (bad flag, unparseable value) or a fatal storage error
(e.g. cannot open the database).

#### Scenario: `runs` with no flags lists recent runs

- **WHEN** the store contains 50 runs and the user invokes
  `minifac runs`
- **THEN** the CLI prints a table with at most 20 rows (the 20
  most recent by `startedAt`), each row identifying the run's
  id-prefix, change (or factory), status, started-at, duration,
  and branch name; the CLI exits `0`

#### Scenario: `--factory` filters by factory

- **WHEN** the user invokes `minifac runs --factory sdd`
- **THEN** every row in the output corresponds to a run whose
  stored `factoryName` is `sdd`; other factories are omitted

#### Scenario: `--status` rejects bad values

- **WHEN** the user invokes `minifac runs --status wat`
- **THEN** the CLI exits `1` with a stderr message naming the
  allowed values (`running`, `succeeded`, `failed`)

#### Scenario: `--json` emits an array including branchName

- **WHEN** the user invokes `minifac runs --limit 3 --json`
  against a store containing at least 3 runs with mixed
  `branchName` values (some `null`, some set)
- **THEN** stdout contains exactly one JSON array of at most 3
  objects (each with at minimum `id`, `factoryName`, `change`,
  `status`, `startedAt`, `endedAt`, and `branchName`); a
  per-row `branchName` of `null` is emitted as JSON `null`;
  the CLI exits `0`

#### Scenario: `--limit` rejects non-positive values

- **WHEN** the user invokes `minifac runs --limit 0` (or `-5`,
  or `abc`)
- **THEN** the CLI exits `1` with a stderr message naming the
  flag and the requirement (positive integer)

#### Scenario: No matches still exits `0`

- **WHEN** the user invokes `minifac runs --change nonexistent`
  and no run has that change
- **THEN** the CLI prints an empty table (or `[]` with `--json`)
  and exits `0`

#### Scenario: Rows with null branchName render blank in the table

- **WHEN** the user invokes `minifac runs` and the store
  contains a row whose `branchName` is `null` (a run from
  before the column was introduced)
- **THEN** that row's branch column is the empty string (or a
  visual equivalent like `-`); the row is otherwise rendered
  as normal

### Requirement: `minifac runs show <id>` subcommand

The CLI SHALL expose a `runs show <id>` subcommand that prints
the event log for a single persisted run. The positional `<id>`
SHALL accept either a full run id or any unambiguous prefix.

The subcommand SHALL accept:

- `--follow` — after printing the buffered events, keep tailing
  the run's events until the run terminates. v0 MAY implement
  tailing via short-interval polling of the store (e.g. every
  250 ms). When `--follow` is supplied for a run whose stored
  status is already terminal, the subcommand SHALL print the
  buffered events and exit `0` without polling.
- `--json` — emit events as JSON, one event object per line
  (newline-delimited JSON), for piping. When combined with
  `--follow`, the subcommand SHALL keep emitting JSON lines
  until the run terminates.

Default output (no `--json`) SHALL prefix each event line with
`[<nodeId>]` for `stdout` and `stderr` events (matching the
existing per-event output of `minifac run`). `status` events
SHALL be rendered in the same distinct format `minifac run`
uses. The synthetic `run_end` event SHALL be rendered as a
final summary line naming the terminal status and reason.

The subcommand SHALL exit:

- `0` on success (event log printed, or `--follow` tail
  completed).
- `1` on a usage error (e.g. unparseable id) or fatal storage
  error.
- `1` on an unknown id (one that doesn't match any run id or
  unambiguous prefix), with a stderr message naming the input.
- `1` on an ambiguous prefix that matches multiple runs, with a
  stderr message naming the matching ids.

#### Scenario: `runs show <id>` prints the event log

- **WHEN** the user invokes `minifac runs show ab12cd34` against
  a store with a run id starting with that prefix
- **THEN** the CLI prints every persisted event for that run in
  `seq` order, each `stdout` / `stderr` event prefixed with its
  node id, then a final summary line for the run's terminal
  status; the CLI exits `0`

#### Scenario: Ambiguous prefix is a usage error

- **WHEN** the user invokes `minifac runs show ab` and two run
  ids share that prefix
- **THEN** the CLI exits `1` with a stderr message naming both
  matching ids; no events are printed

#### Scenario: Unknown id is a usage error

- **WHEN** the user invokes `minifac runs show deadbeef` and no
  run id matches (full or prefix)
- **THEN** the CLI exits `1` with a stderr message naming the
  input

#### Scenario: `--follow` tails an active run

- **WHEN** the user invokes `minifac runs show <id> --follow`
  against a run whose stored status is `running`
- **THEN** the CLI prints buffered events, then continues
  printing newly persisted events as they arrive, then prints
  the terminal-status summary line and exits `0` once the run
  is finalized

#### Scenario: `--follow` on a terminal run does not poll forever

- **WHEN** the user invokes `minifac runs show <id> --follow`
  against a run whose stored status is `succeeded` or `failed`
- **THEN** the CLI prints the buffered events, prints the
  terminal-status summary, and exits `0` promptly without
  entering a polling loop

#### Scenario: `--json` emits NDJSON

- **WHEN** the user invokes `minifac runs show <id> --json`
- **THEN** stdout contains one JSON object per line, one per
  persisted event in `seq` order, with no surrounding array or
  trailing comma; the CLI exits `0`

### Requirement: `minifac merge` subcommand

The CLI SHALL expose a `merge` subcommand that takes a single
positional argument `<arg>` and merges the resolved run's branch
into the caller's default branch. The subcommand SHALL accept
the following flags:

- `--ff-only` — refuse to fall back to a merge commit. If the
  fast-forward attempt fails, the subcommand SHALL exit `1`
  with the git stderr surfaced verbatim, and the working tree
  SHALL be left as it was before the merge attempt.
- `--pick` — interactive picker over `process.stdin` for the
  multiple-succeeded-runs case described below. When the
  resolution is unambiguous, `--pick` SHALL be a no-op.
- `--force` — allow resolution against runs whose status is
  not `succeeded`. Without this flag, only `succeeded` runs
  are considered candidates when `<arg>` is resolved as a
  change name.

#### Resolution

`<arg>` SHALL be resolved against the runs database in the
following order:

1. If `<arg>` is a string of length ≥ 6 whose characters are
   all lowercase hexadecimal AND it matches the prefix of
   exactly one run's `id`, resolve to that row. An ambiguous
   prefix that matches multiple ids SHALL be a usage error
   listing the matching ids.
2. Else, treat `<arg>` as a `change` value. Query for rows
   whose `change = <arg>`. Filter to rows with `status =
   "succeeded"` unless `--force` was supplied.
   - If zero rows match: exit `1` with a stderr message
     naming the change and the filter.
   - If exactly one row matches: use that row.
   - If multiple rows match:
     - Without `--pick`: exit `1` with a stderr message
       listing the matching runs (id-prefix, status,
       started-at, branchName) and suggesting `--pick` or
       passing a run id.
     - With `--pick`: drive a numbered prompt over
       `process.stdin`. The prompt SHALL list the candidates
       in `startedAt` descending order with id-prefix,
       status, branchName, and started-at. The user types a
       number to select; empty input or EOF exits `1`
       without merging.
3. Else (`<arg>` is shorter than 6 chars and not a known
   change), exit `1` with a stderr message naming the input.

The resolved row's `branchName` MUST be non-null. A row with
`branchName = null` (a pre-`0002`-migration row) SHALL be
refused with a stderr message instructing the user that the
run pre-dates per-run branch naming and that they may merge
manually with `git merge <change>` if appropriate. The exit
code SHALL be `1`.

The CLI SHALL track which resolution path succeeded
(`run-id-prefix` vs `change-name`) and SHALL pass that signal
to the merge primitive so the post-merge mark-done step (see
"Mark-done on successful change-by-name merge" below) fires
only when appropriate.

#### Merge sequence

After successful resolution, the subcommand SHALL execute the
following in the caller's repo (cwd):

1. Detect the default branch using the same resolution as
   the `worktree-management` capability's hybrid prune policy:
   the `default_branch` config field, else `origin/HEAD`,
   else `main`.
2. Verify the working tree is clean (`git status` shows no
   modified or untracked-but-tracked-by-index files). If
   dirty, exit `1` with a stderr message naming the dirty
   state and suggesting `git stash`.
3. Checkout the default branch (skipped if the working tree
   is already on it).
4. Attempt `git merge --ff-only <branchName>`.
   - On success: write a one-line stdout summary naming the
     merged branch and the resulting HEAD SHA, then invoke
     the mark-done step described below, then exit `0`.
   - On failure with `--ff-only` supplied: surface the git
     stderr verbatim, exit `1`.
   - On failure without `--ff-only`: proceed to step 5.
5. Attempt `git merge --no-ff -m "Merge <branchName>"
   <branchName>`.
   - On success: write the summary, invoke the mark-done
     step described below, exit `0`.
   - On merge conflict: run `git merge --abort` to leave a
     clean tree, write a stderr message listing the
     conflicting paths (from `git diff --name-only
     --diff-filter=U`), exit `1`.

The subcommand SHALL NOT delete the run's branch after
merging. The subcommand SHALL NOT run `git fetch` or any other
network-touching git command.

#### Mark-done on successful change-by-name merge

When the resolution path was `change-name` (case 2 above) and
the merge succeeded (fast-forward or merge-commit fallback),
the subcommand SHALL invoke the mark-done helper (the same
helper the runner uses, per the `brief-state` capability's
"Runner marks brief done after terminal-success" requirement)
against the caller's cwd to move
`inputs/<change>.md` to `inputs/done/<change>.md` and commit
the move. The helper's idempotent-skip rules SHALL apply: if
the brief is already at `inputs/done/<change>.md` (the
`--no-auto-merge` path, or a manual `minifac run` followed by
`minifac merge`, or a redundant `minifac merge` invocation),
the helper SHALL skip without warning.

If the mark-done helper fails (e.g. the caller's cwd has
uncommitted changes that block `git mv`, or a pre-commit hook
rejects the commit), the subcommand SHALL write a single
stderr warning line naming the failure but SHALL still exit
`0` (the merge itself succeeded, which is the primary
contract of `minifac merge`).

When the resolution path was `run-id-prefix` (case 1 above),
the subcommand SHALL NOT invoke the mark-done helper. The
id-prefix path is reserved for operator scenarios (cherry-
picking a non-latest run, merging a run whose brief has been
deleted or renamed) where calling mark-done would surprise
the operator who explicitly named a single run.

#### Exit codes

- `0` — merge succeeded (fast-forward or merge commit),
  regardless of whether the mark-done helper succeeded or
  emitted a warning.
- `1` — usage error (bad flag, ambiguous prefix, unknown
  arg), resolution refusal (no succeeded runs, null
  `branchName`), dirty working tree, merge failure (ff-only
  refused fallback, or merge conflict).

#### Scenario: Merge by change with one succeeded run fast-forwards

- **WHEN** the user invokes `minifac merge foo`, exactly one
  run with `change = "foo"` has `status = "succeeded"` and
  `branchName = "run/foo-a7b3c1"`, and the caller's default
  branch can fast-forward to that branch
- **THEN** the CLI checks out the default branch, runs
  `git merge --ff-only run/foo-a7b3c1`, prints a one-line
  stdout summary naming the branch and the resulting HEAD,
  invokes the mark-done helper (moving
  `inputs/foo.md` to `inputs/done/foo.md` and committing
  the move), and exits `0`

#### Scenario: Merge by change with multiple succeeded runs requires --pick

- **WHEN** the user invokes `minifac merge foo` and two or
  more runs with `change = "foo"` have `status = "succeeded"`
- **THEN** the CLI exits `1` with a stderr message listing
  the matching runs (id-prefix, status, branchName,
  started-at) and suggesting `--pick` or passing a run id;
  no merge is attempted and no mark-done is invoked

#### Scenario: --pick drives a numbered prompt and merges the selection

- **WHEN** the user invokes `minifac merge foo --pick` with
  three matching succeeded runs and types `2` into the
  prompt followed by a newline
- **THEN** the CLI merges the second listed run's branch into
  the default branch, invokes the mark-done helper for
  `foo` (since the resolution path was change-name), and
  exits `0`

#### Scenario: --pick on empty input exits non-zero without merging

- **WHEN** the user invokes `minifac merge foo --pick` and
  types EOF (or an empty line) at the prompt
- **THEN** the CLI exits `1` with a stderr message indicating
  no selection was made; no merge is attempted and no
  mark-done is invoked

#### Scenario: Merge by run-id prefix resolves to that run

- **WHEN** the user invokes `minifac merge a7b3c1` and exactly
  one run's id begins with `a7b3c1`
- **THEN** the CLI resolves to that run's row and proceeds
  with the merge sequence regardless of whether any other
  succeeded runs exist for the same change; the mark-done
  helper is NOT invoked (resolution path is run-id-prefix)

#### Scenario: Ambiguous run-id prefix is a usage error

- **WHEN** the user invokes `minifac merge a7b3c1` and two run
  ids share that prefix
- **THEN** the CLI exits `1` with a stderr message naming
  both matching ids; no merge is attempted

#### Scenario: Merge refuses non-succeeded runs by default

- **WHEN** the user invokes `minifac merge foo` and the only
  run with `change = "foo"` has `status = "failed"`
- **THEN** the CLI exits `1` with a stderr message naming the
  change and the filter (`status = "succeeded"`); no merge
  is attempted

#### Scenario: --force allows merging non-succeeded runs

- **WHEN** the user invokes `minifac merge foo --force` and
  the only run with `change = "foo"` has `status = "failed"`
  and a non-null `branchName`
- **THEN** the CLI proceeds with the merge sequence using
  that run's branch; on a successful merge the mark-done
  helper is invoked (resolution path is still change-name)

#### Scenario: Merge with conflicts aborts cleanly

- **WHEN** the user invokes `minifac merge foo` and the
  attempted merge produces conflicts (and `--ff-only` is
  NOT supplied)
- **THEN** the CLI runs `git merge --abort` so the working
  tree is clean, writes a stderr message listing the
  conflicting paths, and exits `1`; the mark-done helper is
  NOT invoked

#### Scenario: --ff-only refuses fallback to merge commit

- **WHEN** the user invokes `minifac merge foo --ff-only` and
  `git merge --ff-only` fails (the default branch advanced
  beyond the run's base)
- **THEN** the CLI surfaces the git stderr verbatim, does
  NOT attempt a merge commit, and exits `1`; the working
  tree is left as before; the mark-done helper is NOT
  invoked

#### Scenario: Dirty working tree refuses merge

- **WHEN** the user invokes `minifac merge foo` while the
  working tree has uncommitted changes
- **THEN** the CLI exits `1` with a stderr message naming
  the dirty state and suggesting `git stash`; no checkout
  or merge is attempted

#### Scenario: Merge does NOT delete the run's branch

- **WHEN** `minifac merge foo` succeeds (fast-forward or
  merge commit)
- **THEN** the branch `run/foo-<slug>` is still listed in
  `git branch` output; deletion is the responsibility of
  `minifac prune` or the operator

#### Scenario: Null branchName refuses with a documented message

- **WHEN** the user invokes `minifac merge <run-id>` against
  a run whose `branchName` is `null` (a row from before the
  `branch_name` column was added)
- **THEN** the CLI exits `1` with a stderr message
  explaining that the run pre-dates per-run branch naming
  and that `git merge <change>` may be appropriate manually;
  no merge is attempted

#### Scenario: Merge does not run git fetch

- **WHEN** the user invokes `minifac merge foo` on a machine
  with no network
- **THEN** the CLI completes (success or refusal) without
  attempting any network-touching git command

#### Scenario: Successful change-by-name merge moves brief to done

- **WHEN** the user invokes `minifac merge foo` against a
  successful run whose brief is still at `inputs/foo.md`
  (e.g. autorun's auto-merge previously failed, or
  `--no-auto-merge` was used during autorun, or this was a
  manual `minifac run`)
- **THEN** the merge succeeds, the mark-done helper moves
  the brief to `inputs/done/foo.md` and commits the move,
  the subcommand writes the merge-success stdout summary,
  and exits `0`. A subsequent autorun poll observes the
  brief as `done` and unblocks any dependent briefs

#### Scenario: Successful change-by-name merge is idempotent on already-done briefs

- **WHEN** the user invokes `minifac merge foo` against a
  successful run whose brief has already been moved to
  `inputs/done/foo.md` (e.g. the autorun-driven mark-done
  fired earlier on a previous successful merge attempt)
- **THEN** the merge succeeds (a no-op or fast-forward), the
  mark-done helper observes the brief is already in
  `inputs/done/` and skips per its idempotent-skip rules,
  no warning is emitted, and the subcommand exits `0`

#### Scenario: Successful run-id-prefix merge does NOT mark done

- **WHEN** the user invokes `minifac merge a7b3c1` (a
  run-id-prefix resolution path) and the merge succeeds
- **THEN** the subcommand writes the merge-success stdout
  summary and exits `0`; the mark-done helper is NOT
  invoked, the brief at `inputs/<change>.md` (if it exists)
  stays put, and no commit is created beyond the merge
  itself

#### Scenario: Mark-done failure after successful merge warns but exits zero

- **WHEN** the user invokes `minifac merge foo`, the merge
  succeeds, and the subsequent mark-done helper invocation
  fails (e.g. a pre-commit hook rejects the commit)
- **THEN** the subcommand writes a single stderr warning
  line naming the mark-done failure but exits `0` (the
  merge itself succeeded, which is the primary contract of
  `minifac merge`)

### Requirement: `minifac briefs` subcommand

The CLI SHALL expose a `briefs` subcommand that lists briefs across
both the doneness and activity axes (per the `brief-state`
capability). The subcommand SHALL accept the following options:

- `--state <s>` — filter by doneness, where `s` is one of `active`,
  `done`, or `missing`. Any other value SHALL be a usage error.
- `--activity <s>` — filter by activity, where `s` is one of `none`,
  `running`, `succeeded`, or `failed`. Any other value SHALL be a
  usage error.
- `--ready` — shorthand filter for "active, deps satisfied, and no
  in-flight or recently-succeeded run." A row is `ready` iff its
  doneness is `active`, every entry in its `depends_on` resolves to
  doneness `done`, and its activity is `none` or `failed`.
- `--inputs <d>` — override the inputs directory (default
  `<cwd>/inputs`). Both the active set (`<d>/*.md`) and the done
  set (`<d>/done/*.md`) SHALL be discovered relative to this path.
- `--json` — emit the result as a JSON array (suitable for
  piping). Each object SHALL carry at minimum `change`, `state`,
  `activity`, `deps` (array of `{ change, doneness }`),
  `deps_summary`, and `last_run` (object with `id`, `branch`, and
  `ended_at`, or `null` when no run exists). Output SHALL be sorted
  by `change` ascending for stability.

Default output (no `--json`) SHALL be a compact human-readable
table with at least the columns `change`, `state`, `activity`,
`deps_summary` (e.g. `2/3 done` or `—` when the brief has no
deps), and `last_run` (a short id prefix + branch + ended-at when
present, else `—`). Rows SHALL be sorted by `change` ascending.

The subcommand SHALL discover the set of briefs by scanning the
configured inputs directory: `<inputs>/*.md` is the active set;
`<inputs>/done/*.md` is the done set. A brief that fails to parse
SHALL be reported in the table (or JSON array) with `state` derived
from its file location and `activity` rendered as `parse_error`;
its `deps` SHALL be the empty array. A parse error on a single
brief SHALL NOT abort the listing.

The subcommand SHALL NOT mutate the filesystem and SHALL NOT mutate
the run store. The subcommand SHALL exit `0` on success (including
when zero briefs match the filters) and `1` on a usage error (bad
filter value, unreadable inputs directory).

#### Scenario: `briefs` with no flags lists active and done briefs

- **WHEN** the user invokes `minifac briefs` in a repo whose
  `inputs/` contains `foo.md` and `bar.md`, and whose
  `inputs/done/` contains `baz.md`
- **THEN** the CLI writes a table with at least three rows: `bar`
  (state `active`), `baz` (state `done`), `foo` (state `active`),
  sorted by `change` ascending; the CLI exits `0`

#### Scenario: `--state active` filters out done briefs

- **WHEN** the user invokes `minifac briefs --state active` against
  a repo whose `inputs/` contains `foo.md` and whose
  `inputs/done/` contains `baz.md`
- **THEN** the table contains a row for `foo` only; `baz` is
  omitted; the CLI exits `0`

#### Scenario: `--state` rejects bad values

- **WHEN** the user invokes `minifac briefs --state wat`
- **THEN** the CLI exits `1` with a stderr message naming the
  allowed values (`active`, `done`, `missing`)

#### Scenario: `--activity running` shows only briefs with a running run

- **WHEN** the user invokes `minifac briefs --activity running` and
  the run store reports the most recent row for `foo` has
  `status = "running"` (with no other change matching)
- **THEN** the table contains a row for `foo` only; the CLI exits
  `0`

#### Scenario: `--ready` excludes briefs with unsatisfied deps

- **WHEN** the user invokes `minifac briefs --ready` against a
  repo where `inputs/foo.md` declares `depends_on: [bar]`,
  `inputs/bar.md` is present (active), and no run exists for `foo`
- **THEN** the row for `foo` is omitted (its dep `bar` is not
  done); the CLI exits `0`

#### Scenario: `--ready` excludes briefs with an in-flight run

- **WHEN** the user invokes `minifac briefs --ready` against a
  repo where `inputs/foo.md` has no deps and the most recent run
  row for `foo` has `status = "running"`
- **THEN** the row for `foo` is omitted; the CLI exits `0`

#### Scenario: `--ready` includes briefs whose last run failed

- **WHEN** the user invokes `minifac briefs --ready` and
  `inputs/foo.md` has no deps and the most recent run row for
  `foo` has `status = "failed"`
- **THEN** the row for `foo` is included (`failed` is retryable);
  the CLI exits `0`

#### Scenario: `--json` emits stable array shape

- **WHEN** the user invokes `minifac briefs --json` against a repo
  with one active brief (`foo`, deps `[bar]`) and one done brief
  (`baz`, no deps)
- **THEN** stdout contains exactly one JSON array of length 2,
  sorted by `change` ascending; each object carries `change`,
  `state`, `activity`, `deps`, `deps_summary`, and `last_run`;
  the `last_run` value is an object or `null`; the CLI exits `0`

#### Scenario: Unparseable brief reports parse_error activity

- **WHEN** the user invokes `minifac briefs` in a repo where
  `inputs/foo.md` is malformed (missing closing fence)
- **THEN** the table includes a row for `foo` with `state` derived
  from its file location and `activity` rendered as `parse_error`;
  the row's `deps_summary` is `—` and `last_run` is `—`; the CLI
  exits `0`

#### Scenario: `--inputs` overrides the inputs directory

- **WHEN** the user invokes `minifac briefs --inputs /tmp/other`
- **THEN** the CLI scans `/tmp/other/*.md` for active briefs and
  `/tmp/other/done/*.md` for done briefs; no files under the
  default `<cwd>/inputs` are read

#### Scenario: Empty inputs directory exits `0`

- **WHEN** the user invokes `minifac briefs` in a repo whose
  `inputs/` and `inputs/done/` directories are empty (or absent)
- **THEN** the CLI prints an empty table (or `[]` with `--json`)
  and exits `0`

### Requirement: `minifac steps` subcommand

The CLI SHALL expose a `steps` subcommand that lists the steps
available for use by factory `uses:` references. The subcommand
SHALL accept the following options:

- `--source <local | built-in | all>` — filter by source. Defaults
  to `all`. `local` lists only steps under
  `<cwd>/.minifac/steps/*.yaml`; `built-in` lists only steps under
  `<cwd>/examples/steps/*.yaml`; `all` lists both.
- `--json` — emit a JSON array instead of the default plain-text
  table. Each array element SHALL be an object with the fields
  `name`, `version`, `source` (`"local"` | `"built-in"`),
  `path` (absolute), and `description` (string or `null`).

For each YAML file in scope, the subcommand SHALL attempt to load
it via the step loader (per the `step-schema` capability). On
successful load, the step's identity (`name`, `version`,
`description`) and its resolved source SHALL be included in the
listing. On a load failure (malformed YAML, schema violation), the
subcommand SHALL include a placeholder row that names the file path
and the load-error message, but SHALL NOT exit non-zero on a
per-file failure — discovery should not be aborted by a single
broken step.

The subcommand SHALL exit `0` on successful listing (including when
zero steps are discovered). It SHALL exit `1` only on usage errors
(e.g. an unrecognized `--source` value) or on a fatal I/O error
while scanning the source directories.

The subcommand SHALL NOT require a brief or a factory. It SHALL
NOT make any network call, SHALL NOT invoke `git`, and SHALL NOT
write to any file.

When both a local file and a built-in file share the same `name`,
the subcommand SHALL list both entries (one per source) in `all`
mode; consumers can disambiguate by the `source` column. The
subcommand SHALL NOT apply the bare-name lookup precedence (local
shadows built-in) when listing — the listing is descriptive, not
prescriptive.

#### Scenario: Lists built-in steps by default

- **WHEN** the user invokes `minifac steps` in a directory whose
  `<cwd>/examples/steps/` contains `openspec-propose.yaml`,
  `openspec-apply.yaml`, `openspec-verify.yaml`, and
  `openspec-archive.yaml`, and no `<cwd>/.minifac/steps/` directory
  exists
- **THEN** the CLI prints a four-row table (one row per step)
  containing each step's name, version, source (`built-in`), and
  description; exits `0`

#### Scenario: `--source local` filters to local only

- **WHEN** the user invokes `minifac steps --source local` in a
  directory whose `<cwd>/.minifac/steps/` contains
  `custom-verify.yaml` and whose `<cwd>/examples/steps/` contains
  four built-in steps
- **THEN** the CLI prints a one-row table for `custom-verify` with
  source `local`; the built-in steps are not listed; exits `0`

#### Scenario: `--source built-in` filters to built-in only

- **WHEN** the user invokes `minifac steps --source built-in` in a
  directory whose `<cwd>/.minifac/steps/` contains
  `custom-verify.yaml` and whose `<cwd>/examples/steps/` contains
  four built-in steps
- **THEN** the CLI prints a four-row table for the four built-in
  steps; the local step is not listed; exits `0`

#### Scenario: `--json` emits a JSON array

- **WHEN** the user invokes `minifac steps --json` in a directory
  with two built-in steps and no local steps
- **THEN** stdout contains a JSON array (parseable by
  `JSON.parse`) of two objects, each carrying `name`, `version`,
  `source`, `path`, and `description` fields; exits `0`

#### Scenario: Same-name local and built-in steps both list under `--source all`

- **WHEN** the user invokes `minifac steps` and both
  `<cwd>/.minifac/steps/openspec-verify.yaml` and
  `<cwd>/examples/steps/openspec-verify.yaml` exist
- **THEN** the listing contains two `openspec-verify` rows, one
  with `source: local` and one with `source: built-in`

#### Scenario: Empty directories produce an empty listing

- **WHEN** the user invokes `minifac steps` in a directory with
  no `.minifac/steps/` and no `examples/steps/` directories
- **THEN** the CLI prints a one-line "no steps found" summary (or
  an empty JSON array under `--json`) and exits `0`

#### Scenario: Malformed step file is listed with an error placeholder

- **WHEN** the user invokes `minifac steps` and one of the step
  files under `examples/steps/` has malformed YAML
- **THEN** the listing contains a row for the offending file whose
  `name` column is the file path and whose `version`/`description`
  columns contain the loader error message; the CLI continues to
  list the other files and exits `0`

#### Scenario: Unrecognized `--source` value is a usage error

- **WHEN** the user invokes `minifac steps --source remote`
- **THEN** the CLI writes a usage error to stderr explaining that
  `--source` accepts `local`, `built-in`, or `all`, and exits `1`

#### Scenario: Steps subcommand makes no external calls

- **WHEN** the user invokes `minifac steps` on a machine with no
  network
- **THEN** the CLI runs to completion without attempting any HTTP,
  LLM, or `git` call

### Requirement: Symlink-tolerant main-module guard

The CLI's main-module guard SHALL recognize the script as the
entrypoint regardless of whether `process.argv[1]` is the realpath of
the script or a symlink that resolves to it. Specifically, when
`minifac` is invoked through any symlink-based entrypoint — including
but not limited to `npm link`, a global install (`npm install -g`),
or `npx minifac` — the CLI SHALL execute `runCli` and produce output
identical to a direct invocation of the underlying compiled script
(e.g. `node ./dist/cli.js`).

The guard SHALL NOT throw if `process.argv[1]` is absent (e.g.
`node -e "..."`) or cannot be resolved on disk; in those cases the
guard SHALL evaluate to "not the entrypoint" and `runCli` SHALL NOT
run.

#### Scenario: Symlinked entrypoint runs the CLI

- **GIVEN** a symlink on `$PATH` (created by `npm link`, a global
  install, or any equivalent mechanism) pointing at the compiled
  `dist/cli.js`
- **WHEN** the user invokes `minifac --help` through that symlink
- **THEN** the CLI executes `runCli`, writes the same help output to
  stdout that a direct `node ./dist/cli.js --help` invocation
  produces, and exits with the same exit code (`0`)

#### Scenario: Direct invocation continues to run the CLI

- **GIVEN** a built `dist/cli.js`
- **WHEN** the user invokes `node ./dist/cli.js --help` directly (no
  symlink)
- **THEN** the CLI executes `runCli` and writes help output to stdout
  exactly as before this change

#### Scenario: `node -e` does not trigger `runCli`

- **GIVEN** a `node -e "import('./dist/cli.js')"` invocation in which
  `process.argv[1]` is absent or refers to a script other than
  `dist/cli.js`
- **WHEN** the top-level module of `dist/cli.js` is evaluated as a
  side effect of the import
- **THEN** the main-module guard evaluates to `false`, `runCli` does
  NOT run, and no resolution error is thrown from the guard

### Requirement: `minifac autorun` subcommand

The CLI SHALL expose an `autorun` subcommand that runs the autorun
poll loop (per the `auto-mode` capability's "Autorun poll loop"
requirement). The subcommand SHALL accept the following options:

- `--watch <dir>` — the inputs directory to poll. Default
  `<cwd>/inputs`. If the directory does not exist at startup, the
  CLI SHALL exit `1` with a stderr message naming the path.
- `--max-concurrent <n>` — the parallel-run cap. Default `1`.
  SHALL be a positive integer; zero or negative is a usage error.
- `--interval <ms>` — the poll cadence in milliseconds. Default
  `10000`. SHALL be a positive integer; zero or negative is a
  usage error.
- `--once` — run a single poll cycle, wait for scheduled runs to
  settle, then exit `0`. Mutually exclusive with the default
  long-running behavior (one wins; `--once` wins).
- `--filter <expr>` — restrict the candidate set to briefs whose
  `change` matches. Glob or `/<regex>/<flags?>` syntax (per the
  `auto-mode` capability's "Autorun --filter matching"
  requirement). Invalid expressions are a usage error.
- `--dry-run` — run a single poll cycle, emit decisions, exit `0`.
  Invokes no runs (per the `auto-mode` capability's "Autorun
  --dry-run mode" requirement).
- `--json` — emit log lines as one JSON object per line on stdout
  (per the `auto-mode` capability's "Autorun structured logging"
  requirement).
- `--force` — on the first SIGINT/SIGTERM, kill in-flight child
  executor processes instead of waiting for them to settle (per
  the `auto-mode` capability's "Autorun signal handling"
  requirement).
- `--raw` — force the existing raw line-prefixed / JSON output
  even when stdout is a TTY. Mutually exclusive with `--tui`;
  supplying both SHALL be a usage error.
- `--tui` — force the interactive autorun TUI (per the
  `autorun-tui` capability) even when stdout is not a TTY
  (useful for tests). Mutually exclusive with `--raw` and
  with `--json` (the JSON output stream is a machine-readable
  contract that cannot coexist with a mounted TUI).
- `--no-auto-merge` — opt out of the auto-merge step on
  successful runs (per the `auto-mode` capability's "Autorun
  auto-merge flags" requirement). Default: the auto-merge step
  is enabled.
- `--ff-only` — forbid the merge-commit fallback in the
  auto-merge step (per the `auto-mode` capability's "Autorun
  auto-merge flags" requirement). Default: merge-commit
  fallback is allowed. Supplying `--ff-only` together with
  `--no-auto-merge` SHALL NOT be a usage error; the autorun
  process SHALL emit a single startup-time stderr warning
  line and proceed with auto-merge disabled.

Mode selection SHALL follow this precedence, evaluated in order
(the same precedence the `run-cli` capability's "Event output
format" requirement specifies for `minifac run`):

1. `--raw` flag → raw mode (force, even on a TTY).
2. `--tui` flag → TUI mode (force, even on a non-TTY).
3. Else, if `--json` is supplied → raw mode (the JSON stream
   wins; no TUI is mounted).
4. Else, if `process.stdout.isTTY` is truthy → TUI mode (the
   default for interactive invocations).
5. Else → raw mode (the default for pipes, redirects, and CI).

Supplying `--raw` together with `--tui` SHALL be a usage error
(exit `1`) with a stderr message naming the conflict. Supplying
`--tui` together with `--json` SHALL be a usage error
(exit `1`) with a stderr message naming the conflict.

The subcommand SHALL exit with:

- `0` when the process exits cleanly after `--once`, `--dry-run`,
  a graceful shutdown that drained all in-flight runs, or a
  TUI-driven `q` quit that drained all in-flight runs.
- `1` for usage errors (missing watch directory, bad flag value,
  invalid `--filter` expression, `--raw` + `--tui` together,
  `--tui` + `--json` together).
- `2` when a stop signal (or a second TUI-driven `q`) escalated
  to killing in-flight children (second SIGINT, first signal
  with `--force`, or `--force` with the first TUI quit).

Other exit codes from the `run-cli` capability's "Exit codes"
requirement (`2` from a node failure, `3` from budget exhaustion)
SHALL NOT propagate from individual autorun-scheduled runs to the
autorun process exit code; per-run failures are logged as
`completed status=failed` and the autorun process continues.
Likewise, an `auto-merge-failed` event (per the `auto-mode`
capability's "Autorun auto-merge-failed event" requirement)
SHALL NOT change the autorun process exit code; the autorun
process continues to schedule subsequent ready briefs (subject
to the dependency-blockedness those briefs may now inherit
from the unmerged predecessor).

#### Scenario: `minifac autorun` polls inputs and schedules ready briefs

- **WHEN** the user invokes `minifac autorun` against a repo whose
  `inputs/` contains a ready brief `foo`
- **THEN** the process polls `./inputs`, schedules `foo` using the
  same run primitive `minifac run foo` would, and continues
  polling until a stop signal

#### Scenario: `minifac autorun --once` schedules ready and exits

- **WHEN** the user invokes `minifac autorun --max-concurrent 2
  --once` against a repo whose `inputs/` contains two ready briefs
- **THEN** the process schedules both briefs in parallel, waits
  for them to settle, and exits `0`

#### Scenario: `minifac autorun --dry-run` prints decisions

- **WHEN** the user invokes `minifac autorun --dry-run` against a
  repo whose `inputs/` contains one ready brief (`foo`) and one
  blocked brief (`bar`)
- **THEN** stdout contains a `dry-run-decision` event for `foo`
  (action `schedule`) and a `dry-run-decision` event for `bar`
  (action `skip`, reason `blocked`); no runs are invoked; the CLI
  exits `0`

#### Scenario: Missing watch directory is a usage error

- **WHEN** the user invokes `minifac autorun --watch
  /nonexistent/path`
- **THEN** the CLI writes a stderr message naming the path and
  exits `1`; no poll cycle runs

#### Scenario: Bad `--max-concurrent` value is a usage error

- **WHEN** the user invokes `minifac autorun --max-concurrent 0`
- **THEN** the CLI writes a stderr message naming the flag and the
  positive-integer requirement, and exits `1`

#### Scenario: Bad `--interval` value is a usage error

- **WHEN** the user invokes `minifac autorun --interval -1`
- **THEN** the CLI writes a stderr message naming the flag and the
  positive-integer requirement, and exits `1`

#### Scenario: Bad `--filter` regex is a usage error

- **WHEN** the user invokes `minifac autorun --filter
  "/[unterminated/"`
- **THEN** the CLI writes a stderr message naming the flag and the
  regex parse error, and exits `1`

#### Scenario: SIGINT drains in-flight runs and exits zero

- **WHEN** the user invokes `minifac autorun --max-concurrent 1`,
  one run is scheduled and in flight, and the user sends SIGINT
- **THEN** the CLI stops scheduling, waits for the in-flight run
  to settle, and exits `0`

#### Scenario: Second SIGINT escalates and exits non-zero

- **WHEN** the user invokes `minifac autorun`, a run is in
  flight, the user sends a first SIGINT (CLI waits), and the
  user sends a second SIGINT
- **THEN** the CLI sends SIGTERM to the in-flight child executor,
  waits briefly, and exits `2`

#### Scenario: `--force` escalates on first signal

- **WHEN** the user invokes `minifac autorun --force`, a run is
  in flight, and the user sends a SIGINT
- **THEN** the CLI immediately sends SIGTERM to the in-flight
  child executor, waits briefly, and exits `2`

#### Scenario: Per-run failure does not crash autorun

- **WHEN** the autorun process schedules `foo`, `foo`'s run
  terminates with `failed`, and another ready brief `bar` exists
- **THEN** the autorun process emits a `completed status=failed`
  event for `foo`, continues polling, and schedules `bar` on a
  later poll cycle

#### Scenario: Interactive autorun defaults to TUI

- **WHEN** the user invokes `minifac autorun` in a terminal where
  `process.stdout.isTTY` is truthy and neither `--raw`, `--tui`,
  nor `--json` is supplied
- **THEN** the CLI mounts the autorun TUI per the `autorun-tui`
  capability; the existing human-readable log lines are NOT
  written to stdout while the TUI is mounted

#### Scenario: Non-TTY autorun falls back to raw

- **WHEN** the user invokes `minifac autorun > log` (so stdout
  is not a TTY) and neither `--raw` nor `--tui` is supplied
- **THEN** the CLI emits today's human-readable log lines and
  does NOT mount the TUI

#### Scenario: --raw forces raw mode in a TTY

- **WHEN** the user invokes `minifac autorun --raw` from a TTY
- **THEN** the CLI emits the existing human-readable log lines
  and does NOT mount the TUI

#### Scenario: --tui forces TUI mode in a non-TTY

- **WHEN** the user invokes `minifac autorun --tui` with stdout
  not a TTY (e.g. piped, used by tests)
- **THEN** the CLI mounts the autorun TUI and renders into the
  non-TTY surface (snapshotted by tests via ink's testing
  utilities); the existing log lines are NOT written to stdout
  while the TUI is mounted

#### Scenario: --raw and --tui together is a usage error

- **WHEN** the user invokes `minifac autorun --raw --tui`
- **THEN** the CLI exits `1` with a stderr message naming the
  flag conflict; no poll cycle runs and no TUI is mounted

#### Scenario: --tui and --json together is a usage error

- **WHEN** the user invokes `minifac autorun --tui --json`
- **THEN** the CLI exits `1` with a stderr message naming the
  flag conflict; no poll cycle runs and no TUI is mounted

#### Scenario: --json on a TTY without --tui keeps emitting JSON

- **WHEN** the user invokes `minifac autorun --json` from a TTY
  and `--tui` is NOT supplied
- **THEN** the CLI emits one JSON object per line on stdout (the
  existing `--json` contract is preserved); no TUI is mounted

#### Scenario: --no-auto-merge restores pre-merge behavior

- **WHEN** the user invokes `minifac autorun --no-auto-merge`
  and a scheduled run completes `succeeded`
- **THEN** the autorun process does NOT invoke the merge
  primitive, the runner's mark-done post-step fires exactly
  as it did before the auto-merge step was introduced, the
  brief moves to `inputs/done/<change>.md`, and no
  `auto-merge-failed` event is emitted

#### Scenario: --ff-only propagates to the merge primitive

- **WHEN** the user invokes `minifac autorun --ff-only`,
  a scheduled run completes `succeeded`, and the merge
  primitive's fast-forward attempt against the default
  branch fails
- **THEN** the merge primitive does NOT fall back to a
  merge commit, an `auto-merge-failed` event fires with
  `reason = "non-fast-forward"`, and the brief stays at
  `inputs/<change>.md`

#### Scenario: --no-auto-merge with --ff-only warns and proceeds

- **WHEN** the user invokes `minifac autorun --no-auto-merge
  --ff-only`
- **THEN** the CLI writes a single stderr warning line
  `--ff-only has no effect when --no-auto-merge is supplied`
  at startup, then proceeds with the autorun loop with
  auto-merge disabled (no usage error; exit code 0 / 2 /
  signal-driven per the existing rules)

### Requirement: `minifac runs show <id> --outputs` flag

The `runs show <id>` subcommand SHALL accept an `--outputs` flag
that augments the existing event-log output with a tree of
produced outputs for the resolved run.

When `--outputs` is supplied, after printing the event log (in
the existing format dictated by the `runs show` requirement),
the subcommand SHALL append a section to stdout in the following
shape:

```
Outputs for run <id>:
  <node-id> (iter <N>):
    <output-key> (<type>, <human-readable-size>)
    ...
  ...
```

where:

- The runs are grouped by `node_id ASC`, then `iteration ASC`,
  then `output_key ASC` (the order returned by
  `store.getNodeOutputs(runId)`).
- `<type>` is the literal `value`, `file`, or `directory`.
- `<human-readable-size>` is a SI-style formatted size (e.g.
  `412 B`, `18.2 KB`, `1.1 MB`). For `directory` outputs, the
  formatter SHALL additionally include the file count in
  parentheses (e.g. `directory, 4 files, 22.5 KB`).

When the run has no recorded outputs (pre-v3 run, or a v3+ run
where no node produced anything indexable), the section SHALL be:

```
Outputs for run <id>:
  (none)
```

The flag SHALL combine with `--follow` and `--json`:

- With `--follow`: the outputs section is appended only once, at
  the moment the run reaches a terminal state (so the tail loop
  doesn't reprint the section per polling pass). On a run that
  is already terminal when `--follow` is supplied, the section
  is printed at the end of the buffered events as the subcommand
  exits.
- With `--json`: instead of the human-readable tree, the
  subcommand SHALL emit a single trailing JSON line of the form
  `{"type":"outputs","rows":[<NodeOutputRow>, ...]}` where each
  row matches the `NodeOutputRow` shape from the `run-storage`
  capability's "`recordNodeOutputs` and `getNodeOutputs`"
  requirement. The line SHALL appear after every per-event JSON
  line for the run.

The flag SHALL NOT change exit-code semantics.

#### Scenario: `--outputs` prints a tree

- **WHEN** the user invokes `minifac runs show <id> --outputs`
  against a run with outputs from two nodes (`propose` iter 1,
  `apply` iter 1)
- **THEN** stdout contains the event log followed by an "Outputs
  for run <id>:" section listing both nodes with their iteration
  numbers and per-output `(<type>, <size>)` lines; the CLI
  exits `0`

#### Scenario: `--outputs` against a run with no outputs prints "(none)"

- **WHEN** the user invokes `minifac runs show <id> --outputs`
  against a run that produced no outputs (e.g. a pre-v3 run, or
  a brief-less smoke run)
- **THEN** stdout contains the event log followed by an "Outputs
  for run <id>:\n  (none)" section; the CLI exits `0`

#### Scenario: `--outputs --json` appends a trailing JSON line

- **WHEN** the user invokes `minifac runs show <id> --outputs --json`
  against a run with two output rows
- **THEN** stdout contains the per-event NDJSON lines followed
  by exactly one additional line whose parsed JSON is
  `{"type":"outputs","rows":[<row1>,<row2>]}` with `rows`
  ordered per `getNodeOutputs`; the CLI exits `0`

#### Scenario: `--outputs --follow` prints once at run termination

- **WHEN** the user invokes `minifac runs show <id> --outputs --follow`
  against a `running` run that subsequently produces outputs and
  terminates `succeeded`
- **THEN** stdout streams events as they arrive; the
  outputs-section is appended exactly once, after the terminal
  summary line, before the subcommand exits `0`

#### Scenario: Directory output formatting names file count

- **WHEN** a node produced a `directory` output containing 4
  files totalling 22500 bytes
- **THEN** the corresponding line in the `--outputs` tree reads
  approximately `<key> (directory, 4 files, 22.5 KB)` (or the
  closest SI-rounded equivalent)

### Requirement: `minifac runs cat <id> <selector>` subcommand

The CLI SHALL expose a `runs cat <id> <selector>` subcommand
that prints the contents of one produced output to stdout.

The positional `<id>` SHALL accept either a full run id or any
unambiguous prefix (same resolution rules as `runs show`).

The positional `<selector>` SHALL match one of:

- `<node-id>/<output-key>` — print the latest iteration's
  output for `(node-id, output-key)`.
- `<node-id>:<iteration>/<output-key>` — print the named
  iteration's output for `(node-id, output-key)`. `<iteration>`
  SHALL be a positive integer.
- `<node-id>/<output-key>/<filename>` — when the targeted output
  is `type: "directory"`, print the contents of the named file
  inside that directory.
- `<node-id>:<iteration>/<output-key>/<filename>` — combination
  of the above.

Behavior by output type:

- **`type: "value"`** — print the raw file contents (the
  JSON-on-disk shape). No pretty-printing is applied; the user
  who wants pretty JSON can pipe through `jq` or similar.
- **`type: "file"`** — print the raw file contents.
- **`type: "directory"`** without a trailing `/<filename>` —
  print a per-file listing in the shape:

  ```
  <directory-absolute-path>:
    <relative-path>  <size>
    <relative-path>  <size>
    ...
  ```

  ordered by recursive directory-walk order.
- **`type: "directory"`** with a trailing `/<filename>` — print
  the raw contents of that file inside the directory. The
  `<filename>` SHALL be interpreted relative to the directory
  output's root; the subcommand SHALL refuse to traverse
  outside that root (any `..` segment in `<filename>` is a
  usage error).

The subcommand SHALL exit:

- `0` on successful print.
- `1` on a usage error (malformed selector, ambiguous id,
  unknown id, unknown node id, unknown output key, unknown
  iteration, unknown filename, `..` traversal, fatal I/O).
- `1` when the named output is recorded in `runs.db` but the
  file on disk is missing (e.g. pruned away), with a stderr
  message naming the recorded path.

#### Scenario: Default selector picks latest iteration

- **WHEN** node `verify` ran iterations 1 and 2, both producing
  a `results` value output, and the user invokes
  `minifac runs cat <id> verify/results`
- **THEN** stdout contains the raw contents of iteration 2's
  `results.json`; the CLI exits `0`

#### Scenario: Explicit iteration selector

- **WHEN** the user invokes `minifac runs cat <id> verify:1/results`
  against the same run
- **THEN** stdout contains the raw contents of iteration 1's
  `results.json`; the CLI exits `0`

#### Scenario: Directory selector lists files

- **WHEN** node `verify` produced a `logs` directory output
  containing three files, and the user invokes
  `minifac runs cat <id> verify/logs`
- **THEN** stdout contains the directory's absolute path on the
  first line, followed by one indented line per contained file
  naming its relative path and size; the CLI exits `0`

#### Scenario: Directory selector with filename prints that file

- **WHEN** node `verify` produced a `logs` directory containing
  `run.log`, and the user invokes
  `minifac runs cat <id> verify/logs/run.log`
- **THEN** stdout contains the raw contents of
  `<verify-logs-dir>/run.log`; the CLI exits `0`

#### Scenario: Directory selector rejects path traversal

- **WHEN** the user invokes `minifac runs cat <id> verify/logs/../../etc/passwd`
- **THEN** the CLI writes a usage error to stderr naming the
  offending `..` and exits `1`; no file is read

#### Scenario: Malformed selector is a usage error

- **WHEN** the user invokes `minifac runs cat <id> not-a-selector`
  (no `/`)
- **THEN** the CLI writes a usage error to stderr explaining the
  selector grammar and exits `1`

#### Scenario: Unknown node or key is a usage error

- **WHEN** the user invokes `minifac runs cat <id>
  nonexistent/findings` against a run with no `nonexistent` node
- **THEN** the CLI writes a stderr message naming the unknown
  node and exits `1`

#### Scenario: Missing on-disk file is a runtime error

- **WHEN** the user invokes `minifac runs cat <id> propose/findings`
  against a run whose `node_outputs` row recorded a path that
  no longer exists on disk (e.g. the iteration directory was
  pruned manually)
- **THEN** the CLI writes a stderr message naming the recorded
  path and exits `1`

