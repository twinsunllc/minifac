## MODIFIED Requirements

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

## ADDED Requirements

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
     merged branch and the resulting HEAD SHA, exit `0`.
   - On failure with `--ff-only` supplied: surface the git
     stderr verbatim, exit `1`.
   - On failure without `--ff-only`: proceed to step 5.
5. Attempt `git merge --no-ff -m "Merge <branchName>"
   <branchName>`.
   - On success: write the summary, exit `0`.
   - On merge conflict: run `git merge --abort` to leave a
     clean tree, write a stderr message listing the
     conflicting paths (from `git diff --name-only
     --diff-filter=U`), exit `1`.

The subcommand SHALL NOT delete the run's branch after
merging. The subcommand SHALL NOT run `git fetch` or any other
network-touching git command.

#### Exit codes

- `0` — merge succeeded (fast-forward or merge commit).
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
  and exits `0`

#### Scenario: Merge by change with multiple succeeded runs requires --pick

- **WHEN** the user invokes `minifac merge foo` and two or
  more runs with `change = "foo"` have `status = "succeeded"`
- **THEN** the CLI exits `1` with a stderr message listing
  the matching runs (id-prefix, status, branchName,
  started-at) and suggesting `--pick` or passing a run id;
  no merge is attempted

#### Scenario: --pick drives a numbered prompt and merges the selection

- **WHEN** the user invokes `minifac merge foo --pick` with
  three matching succeeded runs and types `2` into the
  prompt followed by a newline
- **THEN** the CLI merges the second listed run's branch into
  the default branch and exits `0`

#### Scenario: --pick on empty input exits non-zero without merging

- **WHEN** the user invokes `minifac merge foo --pick` and
  types EOF (or an empty line) at the prompt
- **THEN** the CLI exits `1` with a stderr message indicating
  no selection was made; no merge is attempted

#### Scenario: Merge by run-id prefix resolves to that run

- **WHEN** the user invokes `minifac merge a7b3c1` and exactly
  one run's id begins with `a7b3c1`
- **THEN** the CLI resolves to that run's row and proceeds
  with the merge sequence regardless of whether any other
  succeeded runs exist for the same change

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
  that run's branch

#### Scenario: Merge with conflicts aborts cleanly

- **WHEN** the user invokes `minifac merge foo` and the
  attempted merge produces conflicts (and `--ff-only` is
  NOT supplied)
- **THEN** the CLI runs `git merge --abort` so the working
  tree is clean, writes a stderr message listing the
  conflicting paths, and exits `1`

#### Scenario: --ff-only refuses fallback to merge commit

- **WHEN** the user invokes `minifac merge foo --ff-only` and
  `git merge --ff-only` fails (the default branch advanced
  beyond the run's base)
- **THEN** the CLI surfaces the git stderr verbatim, does
  NOT attempt a merge commit, and exits `1`; the working
  tree is left as before

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
