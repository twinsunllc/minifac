## MODIFIED Requirements

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
