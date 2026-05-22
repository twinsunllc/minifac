## MODIFIED Requirements

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
   invocation. Resolve `<thing>` as a factory name using the
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
  lookup and resolve via the install-root-first / source-tree-
  fallback two-step lookup:
    1. `<install-root>/examples/<name>.yaml`, where `<install-root>`
       is the directory containing the running runner's `package.json`.
    2. `<cwd>/examples/<name>.yaml`.
  The first existing file wins. When running from the minifac source
  tree, the two paths collapse to the same file. The local
  `.minifac/factories/<name>.yaml` SHALL NOT be consulted for
  `minifac:<name>` references.
- `<name>` (no prefix) — try `<cwd>/.minifac/factories/<name>.yaml`
  first; if that path does not exist, fall back to
  `<cwd>/examples/<name>.yaml`. A bare `<name>` lookup SHALL NOT
  consult the install root. A `<name>` lookup succeeds at whichever
  candidate exists; if none exists, factory-by-name resolution
  fails.

A brief whose `factory:` field uses the `minifac:` prefix SHALL
resolve via the install-root-first lookup even when an equally-named
`.minifac/factories/<name>.yaml` exists. A brief whose `factory:`
field is a bare `<name>` SHALL prefer the local file when present
and SHALL NOT consult the install root. The same precedence applies
to the `--factory` flag value.

When a brief is resolved (steps 1 or 2), the CLI SHALL further
resolve the brief's frontmatter `factory:` field using the same
factory-by-name resolution above. A brief whose `factory:` field
does not resolve to any candidate path SHALL exit `1` with an error
naming the missing factory and, for the `minifac:<name>` form, both
paths tried (install-root and source-tree); for the bare `<name>`
form, both paths tried (local `.minifac/factories/` and source-tree
`examples/`).

**`--factory <name>` override.** When `--factory <name>` is
supplied (steps 1 or 2 — i.e. a brief-driven invocation), the flag
value SHALL replace the brief's `factory:` field for this
invocation. The brief file SHALL NOT be modified. The flag value
SHALL be resolved through the same factory-by-name resolution
above and SHALL be subject to the same error contract: a flag
value that does not resolve to any candidate path SHALL exit `1`
with an error naming the unresolved value and both paths tried for
that form. The override SHALL take effect *before* the
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

#### Scenario: Brief's bare `factory:` falls back to source-tree built-in

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief's
  frontmatter declares `factory: sdd`,
  `.minifac/factories/sdd.yaml` does not exist, and
  `<cwd>/examples/sdd.yaml` exists
- **THEN** the CLI loads `<cwd>/examples/sdd.yaml`; the install
  root is NOT consulted for bare references

#### Scenario: Brief's `minifac:<name>` resolves from install root first

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief's
  frontmatter declares `factory: minifac:sdd`,
  `<install-root>/examples/sdd.yaml` exists, and both
  `.minifac/factories/sdd.yaml` and `<cwd>/examples/sdd.yaml` exist
- **THEN** the CLI loads `<install-root>/examples/sdd.yaml`; the
  local file and the source-tree `examples/` are not consulted

#### Scenario: Brief's `minifac:<name>` falls back to source-tree

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief's
  frontmatter declares `factory: minifac:sdd`,
  `<install-root>/examples/sdd.yaml` does not exist, and
  `<cwd>/examples/sdd.yaml` exists
- **THEN** the CLI loads `<cwd>/examples/sdd.yaml`

#### Scenario: Brief's `minifac:<name>` with no matching built-in fails

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief's
  frontmatter declares `factory: minifac:nonexistent`, neither
  `<install-root>/examples/nonexistent.yaml` nor
  `<cwd>/examples/nonexistent.yaml` exists
- **THEN** the CLI exits `1` with an error naming
  `minifac:nonexistent` and both absolute paths tried, even if a
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

#### Scenario: --factory with `minifac:` prefix forces built-in via install root

- **WHEN** the user invokes `minifac run foo --factory minifac:sdd`,
  `<install-root>/examples/sdd.yaml` exists, and both
  `.minifac/factories/sdd.yaml` and `<cwd>/examples/sdd.yaml` exist
- **THEN** the CLI loads `<install-root>/examples/sdd.yaml`,
  ignoring the local file and the source-tree `examples/`; the run
  row's `factoryName` is `sdd` and `factoryPath` resolves to the
  install-root file

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
  --factory minifac:nonexistent`, neither
  `<install-root>/examples/nonexistent.yaml` nor
  `<cwd>/examples/nonexistent.yaml` exists
- **THEN** the CLI exits `1` with a stderr message naming
  `minifac:nonexistent` and both absolute paths tried, in order;
  the local `.minifac/factories/nonexistent.yaml` (if any) is not
  consulted

#### Scenario: --factory on a brief-less invocation is a usage error

- **WHEN** the user invokes `minifac run hello --factory sdd`,
  `inputs/hello.md` does not exist, `examples/hello.yaml` exists,
  and the invocation would otherwise resolve as a brief-less
  factory run
- **THEN** the CLI exits `1` with a stderr message naming the
  conflict (`--factory` is only meaningful with a brief); no
  worktree is created, no lock is claimed

### Requirement: `minifac steps` subcommand

The CLI SHALL expose a `steps` subcommand that lists the steps
available for use by factory `uses:` references. The subcommand
SHALL accept the following options:

- `--source <local | built-in | all>` — filter by source. Defaults
  to `all`. `local` lists only steps under
  `<cwd>/.minifac/steps/*.yaml`; `built-in` lists only steps under
  the runner's bundled-built-in directory, namely
  `<install-root>/examples/steps/*.yaml`, where `<install-root>` is
  the directory containing the running runner's `package.json`. If
  the install-root directory does not exist (e.g. running from an
  unusual build layout), the subcommand SHALL fall back to
  `<cwd>/examples/steps/*.yaml` to preserve source-tree
  discoverability. `all` is the union of `local` and `built-in`.
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

#### Scenario: Lists bundled built-in steps by default

- **WHEN** the user invokes `minifac steps` from an
  npm-installed minifac whose `<install-root>/examples/steps/`
  contains `openspec-propose.yaml`, `openspec-apply.yaml`,
  `openspec-verify.yaml`, and `openspec-archive.yaml`, and no
  `<cwd>/.minifac/steps/` directory exists
- **THEN** the CLI prints a four-row table (one row per step)
  containing each step's name, version, source (`built-in`), and
  description; the `path` (under `--json`) names the install-root
  absolute path; exits `0`

#### Scenario: Lists source-tree built-in steps when install root has none

- **WHEN** the user invokes `minifac steps` from a minifac source
  tree where the runner's install-root `examples/steps/` happens
  to be the same as `<cwd>/examples/steps/`
- **THEN** the listing names that directory's step files with
  source `built-in`; exits `0`

#### Scenario: `--source local` filters to local only

- **WHEN** the user invokes `minifac steps --source local` in a
  directory whose `<cwd>/.minifac/steps/` contains
  `custom-verify.yaml` and whose install root contains four built-
  in steps
- **THEN** the CLI prints a one-row table for `custom-verify` with
  source `local`; the built-in steps are not listed; exits `0`

#### Scenario: `--source built-in` filters to built-in only

- **WHEN** the user invokes `minifac steps --source built-in` in a
  directory whose `<cwd>/.minifac/steps/` contains
  `custom-verify.yaml` and whose install root contains four built-
  in steps
- **THEN** the CLI prints a four-row table for the four built-in
  steps from the install root; the local step is not listed;
  exits `0`

#### Scenario: `--json` emits a JSON array

- **WHEN** the user invokes `minifac steps --json` with two
  built-in steps available and no local steps
- **THEN** stdout contains a JSON array (parseable by
  `JSON.parse`) of two objects, each carrying `name`, `version`,
  `source`, `path`, and `description` fields; exits `0`

#### Scenario: Same-name local and built-in steps both list under `--source all`

- **WHEN** the user invokes `minifac steps` and both
  `<cwd>/.minifac/steps/openspec-verify.yaml` and
  `<install-root>/examples/steps/openspec-verify.yaml` exist
- **THEN** the listing contains two `openspec-verify` rows, one
  with `source: local` and one with `source: built-in`

#### Scenario: Empty directories produce an empty listing

- **WHEN** the user invokes `minifac steps` in a directory with
  no `.minifac/steps/` directory and from an install whose
  built-in directory is also empty
- **THEN** the CLI prints a one-line "no steps found" summary (or
  an empty JSON array under `--json`) and exits `0`

#### Scenario: Malformed step file is listed with an error placeholder

- **WHEN** the user invokes `minifac steps` and one of the step
  files in scope has malformed YAML
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
