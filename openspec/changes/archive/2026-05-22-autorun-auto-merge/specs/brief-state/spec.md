## MODIFIED Requirements

### Requirement: Runner marks brief done after terminal-success

The runner SHALL execute a mark-done post-step against the worktree
(or in-place cwd, in `--in-place` mode) after observing the
factory's terminal-success status but before recording the run as
`succeeded` in the run store, UNLESS the caller passed the
`skipMarkDone: true` option on the runner's options surface. The
post-step SHALL be:

1. If the brief frontmatter lacks a `change` value, skip (defensive
   — every brief has a `change` today; the post-step is no-op for
   brief-less factory invocations).
2. If `<runCwd>/inputs/<change>.md` does not exist AND
   `<runCwd>/inputs/done/<change>.md` already exists, treat as
   idempotent and skip the post-step (no warning).
3. Otherwise:
   - Ensure `<runCwd>/inputs/done/` exists, creating it if absent.
   - Run `git -C <runCwd> mv inputs/<change>.md
     inputs/done/<change>.md`.
   - Run `git -C <runCwd> commit -m "Mark <change> done"`.

If any step in (3) exits non-zero, the runner SHALL log a single
warning surfacing the git stderr and SHALL continue to record the
run as `succeeded`. A post-step failure SHALL NOT downgrade the
terminal status, append to the failed-run journal, or change the
process exit code.

The factory's nodes — including the SDD archive node — SHALL NOT
have any responsibility for the move. The mark-done step is a
minifac-level contract that holds regardless of which factory ran.

The `skipMarkDone` option is a caller-supplied boolean (default
`false`) that the runner SHALL accept on its options surface
(`RunOptions` or equivalent). When `skipMarkDone === true`, the
runner SHALL NOT invoke the mark-done post-step on
terminal-success; the runs row is still recorded as `succeeded`
and the brief is left at `inputs/<change>.md`. The option is
intended for callers (currently: the `auto-mode` capability's
autorun wrapper, when its auto-merge step is enabled) that own
the mark-done invocation themselves so they can gate it on a
later-stage action (e.g. a successful auto-merge). The runner
itself takes no opinion on what the caller does in that case;
it simply omits the post-step. The same mark-done helper the
runner uses internally SHALL be exported (or otherwise made
callable) so callers using `skipMarkDone: true` can invoke it
themselves with identical behavior — same git mv, same commit
message, same idempotent-skip rules.

Manual `minifac run` callers SHALL NOT set `skipMarkDone`; the
default behavior (the runner does the move) is preserved for
that path so the manual two-step flow (`minifac run` followed by
`minifac merge`) is unchanged.

#### Scenario: Successful run moves the brief to inputs/done/

- **WHEN** a worktree-mode run for change `foo` terminates with
  `succeeded` and `<runCwd>/inputs/foo.md` exists
- **THEN** the runner executes `git mv inputs/foo.md
  inputs/done/foo.md` followed by a `git commit -m "Mark foo done"`
  in the worktree; the run is then recorded as `succeeded`

#### Scenario: First mark-done in a repo creates inputs/done/

- **WHEN** a successful run is the first to write to
  `inputs/done/` in a repo (the directory does not yet exist)
- **THEN** the runner creates `inputs/done/` in the worktree
  before invoking `git mv`, and the resulting commit includes the
  new directory

#### Scenario: Brief already in inputs/done/ is an idempotent skip

- **WHEN** a successful run for change `foo` terminates and
  `<runCwd>/inputs/foo.md` does not exist while
  `<runCwd>/inputs/done/foo.md` already does (e.g. the factory
  itself moved it, or a manual `git mv` happened earlier in the
  worktree)
- **THEN** the runner does not invoke `git mv` or `git commit`,
  emits no warning, and records the run as `succeeded`

#### Scenario: git mv failure logs a warning but still succeeds

- **WHEN** a successful run's mark-done step fails (e.g. the
  worktree has uncommitted changes that block `git mv`, or a
  pre-commit hook rejects the commit)
- **THEN** the runner writes a single stderr warning line naming
  the change, the failed command, and the underlying git stderr;
  the run is recorded as `succeeded` (not `failed`); the process
  exit code is `0`

#### Scenario: Failed factory run does not invoke mark-done

- **WHEN** a run terminates with status `failed`
- **THEN** the runner SHALL NOT invoke the mark-done post-step;
  the brief SHALL remain at `inputs/<change>.md`

#### Scenario: skipMarkDone option suppresses the post-step

- **WHEN** a caller invokes the runner with `skipMarkDone: true`
  and the factory terminates `succeeded`
- **THEN** the runner SHALL NOT invoke the mark-done helper, the
  brief SHALL remain at `inputs/<change>.md`, the runs row SHALL
  still be recorded as `succeeded`, and no mark-done warning
  SHALL be emitted

#### Scenario: skipMarkDone defaults to false for manual run

- **WHEN** the `minifac run` CLI invokes the runner without
  setting `skipMarkDone` (the manual one-shot path)
- **THEN** the runner SHALL invoke the mark-done post-step on
  terminal-success exactly as it did before this option existed
  (the manual two-step flow remains unchanged)
