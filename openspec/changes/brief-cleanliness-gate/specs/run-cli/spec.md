## ADDED Requirements

### Requirement: `minifac run` brief cleanliness gate

The `minifac run` subcommand SHALL, after resolving the brief and
its factory but BEFORE claiming the lockfile or creating any
worktree, invoke the `brief-cleanliness` capability's
`checkBriefAndAncestorsCleanliness` requirement against the
resolved brief.

The subcommand SHALL accept a new boolean flag
`--require-clean`. This flag has no default; presence flips the
behavior. The flag SHALL appear in `--help` output and in the
CLI reference documentation.

Behavior by cleanliness result:

1. **Clean** → unchanged behavior. No warning, no pause; the
   subcommand proceeds with lockfile / worktree / dispatch as
   specified by the existing `minifac run` command requirement.

2. **Unclean + `--require-clean` supplied** → the subcommand
   SHALL write a single-line error to stderr of the shape:

   ```
   error: brief inputs/<offending>.md is uncommitted (<code>); commit it or drop --require-clean to proceed.
   ```

   where `<offending>` is the offending brief's `change` name
   (either the root brief or an unclean ancestor) and `<code>` is
   the porcelain status code. The subcommand SHALL exit with a
   non-zero exit status and SHALL NOT claim any lockfile, create
   any worktree, or invoke any runner node.

3. **Unclean + `--require-clean` NOT supplied** → the subcommand
   SHALL write a multi-line warning to stderr of the shape:

   ```
   warning: brief inputs/<offending>.md is uncommitted (<code>); the run worktree will see the committed version, which may differ.
   proceed anyway in 3s... (Ctrl-C to abort)
   ```

   Then:
   - If `process.stdin.isTTY` is truthy, the subcommand SHALL
     pause for 3000ms (using a promise-returning timer) before
     proceeding. A SIGINT during the pause SHALL terminate the
     process (no lock claimed yet, nothing to clean up).
   - If `process.stdin.isTTY` is falsy, the subcommand SHALL
     NOT pause; it SHALL print the warning and proceed
     immediately.

   In both sub-cases the subcommand SHALL then proceed with the
   existing lockfile / worktree / dispatch sequence.

4. **Disabled (not in a git working tree)** → the subcommand
   SHALL NOT print any warning, SHALL NOT pause, and SHALL
   proceed exactly as today.

The gate SHALL apply only to brief-driven invocations of
`minifac run` (steps 1 or 2 of the existing thing-resolution
sequence). Brief-less factory invocations (step 3) SHALL NOT
invoke the cleanliness probe; `--require-clean` on a brief-less
invocation SHALL be silently ignored (it has no brief to check).

If the recursive walk throws `BriefCycleError`, the existing
cycle-rejection path (which exits `1` naming the cycle, even
under `--force`) SHALL handle it; the cleanliness gate SHALL
NOT print a separate error in that case.

#### Scenario: Clean brief is unaffected

- **WHEN** the user invokes `minifac run foo` against a clean
  `inputs/foo.md` (and clean ancestors)
- **THEN** no warning is printed, no pause occurs, and the
  subcommand proceeds with the existing lock / worktree /
  dispatch sequence

#### Scenario: --require-clean rejects an unclean brief

- **WHEN** the user invokes `minifac run foo --require-clean`
  and `inputs/foo.md` is untracked
- **THEN** stderr contains a line of the shape
  `error: brief inputs/foo.md is uncommitted (??); commit it or drop --require-clean to proceed.`,
  the process exits non-zero, and no lock is claimed, no
  worktree is created, no node executes

#### Scenario: --require-clean rejects an unclean ancestor

- **WHEN** the user invokes `minifac run foo --require-clean`,
  `inputs/foo.md` is committed, `foo` depends on `bar`, and
  `inputs/bar.md` is modified-but-tracked
- **THEN** stderr contains a line naming
  `inputs/bar.md is uncommitted ( M)` and the recovery gesture;
  the process exits non-zero with no lock / worktree / nodes

#### Scenario: Unclean brief on TTY warns and pauses 3s

- **WHEN** the user invokes `minifac run foo` (no
  `--require-clean`) from a terminal where `process.stdin.isTTY`
  is truthy and `inputs/foo.md` is untracked
- **THEN** stderr contains the multi-line warning naming
  `inputs/foo.md`, the porcelain code `??`, and the "proceed
  anyway in 3s... (Ctrl-C to abort)" gesture; the subcommand
  pauses approximately 3000ms; then it proceeds with the
  existing lock / worktree / dispatch sequence

#### Scenario: Unclean brief on non-TTY warns and proceeds immediately

- **WHEN** the user invokes `minifac run foo` from a non-TTY
  context (e.g. piped or in CI) where `process.stdin.isTTY` is
  falsy and `inputs/foo.md` is untracked
- **THEN** stderr contains the same warning text, NO pause
  occurs, and the subcommand proceeds with the existing
  dispatch sequence

#### Scenario: Disabled gate is silent

- **WHEN** the user invokes `minifac run foo` and the working
  directory is not inside any git repository
- **THEN** no cleanliness warning or error is printed, no pause
  occurs, and the subcommand proceeds with the existing
  dispatch sequence

#### Scenario: --require-clean on a brief-less factory invocation is a no-op

- **WHEN** the user invokes `minifac run hello --require-clean`
  and `hello` resolves as a brief-less factory invocation (no
  `inputs/hello.md` exists, `examples/hello.yaml` exists with
  `brief: "none"`)
- **THEN** `--require-clean` is silently ignored (there is no
  brief to check), and the subcommand proceeds normally
