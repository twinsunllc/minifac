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
