# brief-cleanliness-gate

## Why

`minifac autorun` dispatches briefs based on the working-tree copy of
`inputs/<change>.md`, but the run worktree it creates from a git ref
sees the *committed* copy. Untracked or modified-but-uncommitted briefs
silently produce a divergence between what the operator thinks they're
running and what the spawned factory actually executes. Briefs are
first-class git-tracked artifacts per [[0015-Brief-Deps-and-State]];
letting autorun fire on non-committed files breaks that invariant.

The binding decision is recorded in
`docs/decisions/0033-Brief-Cleanliness-Gate.md`.

## What Changes

- **ADD** a `src/brief/cleanliness.ts` module exposing
  `checkBriefCleanliness` and `checkBriefAndAncestorsCleanliness`.
  The probe shells out to `git status --porcelain -- <path>` (via
  the existing `runGit` helper) and returns `clean`, `unclean` with
  the porcelain status code, or `disabled` (not in a git repo).
- **ADD** a new `unclean` value to the autorun `SkipReason` enum.
- **ADD** scheduler integration: `decide()` runs the cleanliness
  check (recursively over `depends_on`) after `in-flight` /
  `filtered` short-circuits and before `computeBriefState`. An
  unclean brief or unclean ancestor → `skip` with `reason: "unclean"`
  and a `detail` string carrying the porcelain code (and the
  offending ancestor name when applicable).
- **ADD** a one-time startup warning when the autorun process
  detects that `inputs/` is outside any git working tree, after
  which the gate degrades to a no-op.
- **ADD** warn-and-pause behavior to `minifac run <change>` on an
  unclean brief: print a stderr warning, pause 3 seconds on a TTY
  (immediate on non-TTY), then proceed. No pause for clean briefs;
  no warning when the gate is disabled.
- **ADD** a `--require-clean` flag to `minifac run` that converts
  the warning into a hard error (exit non-zero) when the brief or
  any ancestor is unclean.
- **MODIFY** the `unclean` skip-logging path (raw + JSON) so
  operators see a clear recovery gesture and ancestor naming.
- **UPDATE** concept docs (`docs/concepts/Auto-Mode.md`,
  `docs/concepts/Brief.md`) and the CLI reference
  (`docs/CLI.md`) to cover the gate's behavior and the new flag.

The gate is brief-file-scoped only: working-tree WIP under `src/`,
`docs/`, or anywhere else outside `inputs/<change>.md` (and its
`depends_on` ancestors) does NOT trip it. Sentinel `depends_on`
entries with no corresponding brief file are ignored (mirroring
how the state machine treats them as permanently `missing`). A
`depends_on` cycle propagates as `BriefCycleError`, which the
scheduler already converts into the existing `blocked` skip.

## Capabilities

### New Capabilities

- `brief-cleanliness`: the cleanliness probe and its recursive
  ancestor walk, exposed as a testable contract. Other callers
  (autorun scheduler, one-shot run) consume it.

### Modified Capabilities

- `auto-mode`: autorun's `SkipReason` enum gains `unclean`; the
  poll loop's scheduling decision runs the cleanliness check
  before state computation; structured logging documents the new
  reason and its `detail` shape; a one-time startup warning fires
  when the gate is disabled.
- `run-cli`: `minifac run` gains a `--require-clean` flag; on an
  unclean brief without the flag it prints a warning and pauses
  3s (TTY only) before dispatching; with the flag, an unclean
  brief is a hard error.

## Impact

- **Code:** new `src/brief/cleanliness.ts`; edits to
  `src/cli/autorun-scheduler.ts`, `src/cli/autorun.ts` (skip-log
  helper), `src/cli/run-brief.ts` and `src/cli.ts` (flag wiring).
- **Tests:** new `src/brief/cleanliness.test.ts`; extensions to
  `src/cli/autorun-scheduler.test.ts` and
  `src/cli/run-brief.test.ts`. Test fixtures use real temp git
  repos (shell or `simple-git`).
- **Docs:** new "Cleanliness gate" section in
  `docs/concepts/Auto-Mode.md`; mention of the commit expectation
  in `docs/concepts/Brief.md`; updates to `docs/CLI.md` for the
  new flag and skip reason.
- **Behavior change for operators:** uncommitted briefs no longer
  autorun. One-shot `minifac run` keeps working (now with a
  warning + 3s pause), preserving the dogfood-before-commit
  authoring loop. CI / strict use opts in via `--require-clean`.
- **No data migration.** No schema change. No external API change.
