## MODIFIED Requirements

### Requirement: `minifac run` command

The CLI SHALL expose a `run` subcommand that takes a single positional
argument `<thing>`, an optional `--in-place` flag, and an optional
`--force` flag. The CLI SHALL resolve `<thing>` to a brief, a factory,
or an error using the following lookup precedence, evaluated in order
against the directory the CLI was invoked from (cwd):

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

**Factory-by-name resolution** (used both by step 3 above and by the
brief's `factory:` field when the brief is loaded via step 1 or 2)
SHALL accept two forms:

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

When a brief is resolved (steps 1 or 2), the CLI SHALL further
resolve the brief's frontmatter `factory:` field using the same
factory-by-name resolution above. A brief whose `factory:` field
does not resolve to any candidate path SHALL exit `1` with an error
naming the missing factory (and, for the bare `<name>` form, naming
both paths tried).

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

## ADDED Requirements

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
