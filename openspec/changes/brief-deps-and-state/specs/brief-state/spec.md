## ADDED Requirements

### Requirement: Brief doneness derivation

A brief's *doneness* SHALL be derived from the filesystem location
of its file. The doneness vocabulary is exactly the three literal
values `active`, `done`, and `missing`.

The derivation SHALL be a pure filesystem check against the
caller's repo, with no git invocations beyond the `inputs/`
directory layout being committed alongside the rest of the
codebase. Given an inputs directory `<inputsDir>` and a change name
`<change>`:

- If `<inputsDir>/<change>.md` exists, doneness is `active` and the
  resolved file path SHALL be returned alongside.
- Else if `<inputsDir>/done/<change>.md` exists, doneness is `done`
  and the resolved file path SHALL be returned alongside.
- Else doneness is `missing` and no file path SHALL be returned.

A brief whose file exists in both `<inputsDir>` and
`<inputsDir>/done/` SHALL be resolved as `active`. (The runner's
mark-done post-step is responsible for removing the active copy
when moving a brief to `done/`; a transient overlap should not
happen in practice, but the active location wins.)

#### Scenario: Active brief resolves to active

- **WHEN** `inputs/foo.md` exists and `inputs/done/foo.md` does not
- **THEN** `computeBriefDoneness("foo", ...)` returns
  `{ doneness: "active", filePath: <absolute path to inputs/foo.md> }`

#### Scenario: Done brief resolves to done

- **WHEN** `inputs/foo.md` does not exist and `inputs/done/foo.md`
  exists
- **THEN** `computeBriefDoneness("foo", ...)` returns
  `{ doneness: "done", filePath: <absolute path to inputs/done/foo.md> }`

#### Scenario: Missing brief resolves to missing

- **WHEN** neither `inputs/foo.md` nor `inputs/done/foo.md` exists
- **THEN** `computeBriefDoneness("foo", ...)` returns
  `{ doneness: "missing" }` with no `filePath`

### Requirement: Brief activity derivation

A brief's *activity* SHALL be derived from the most recent row in
the run store for that change. The activity vocabulary is exactly
the four literal values `none`, `running`, `succeeded`, and
`failed`.

The derivation SHALL issue a single `listRuns({ change, limit: 1 })`
query (with results sorted by `started_at` descending, per the
existing `run-storage` capability). The first row's `status` SHALL
be mapped to `running`, `succeeded`, or `failed` as appropriate.
When no row exists for the change, activity is `none`.

When a row is returned, the derivation SHALL also surface the row's
`id`, `branch_name`, and `ended_at` so callers (the `briefs`
subcommand, the runner's refusal path) can show the user which run
the activity refers to without a second query.

#### Scenario: No runs for the change resolves to none

- **WHEN** the run store contains no row whose `change = "foo"`
- **THEN** `computeBriefActivity("foo", ...)` returns
  `{ activity: "none" }` with no `mostRecentRunId`

#### Scenario: Running run resolves to running

- **WHEN** the most recent row for `change = "foo"` has
  `status = "running"`
- **THEN** `computeBriefActivity("foo", ...)` returns
  `{ activity: "running", mostRecentRunId: <row.id>,
    branchName: <row.branchName ?? undefined>,
    endedAt: <row.endedAt ?? undefined> }`

#### Scenario: Most recent succeeded run resolves to succeeded

- **WHEN** two rows exist for `change = "foo"` — an older `failed`
  and a newer `succeeded`
- **THEN** `computeBriefActivity("foo", ...)` returns
  `{ activity: "succeeded", mostRecentRunId: <newer.id>, ... }`;
  the older row's status is not surfaced

#### Scenario: Most recent failed run resolves to failed

- **WHEN** the most recent row for `change = "foo"` has
  `status = "failed"`
- **THEN** `computeBriefActivity("foo", ...)` returns
  `{ activity: "failed", mostRecentRunId: <row.id>, ... }`

### Requirement: Combined brief state and dep satisfaction

The combined brief state for a given change SHALL be the
composition of the brief's doneness, activity, and the doneness of
each entry in its `depends_on` frontmatter field. A dep SHALL be
considered *satisfied* iff its doneness is `done`. A brief is
*blocked* iff at least one of its declared deps is unsatisfied.

The combined resolution function SHALL accept the change name plus
the inputs directory, the repo root, and the run store. It SHALL
return at least:

- `doneness` — the root brief's doneness.
- `activity` — the root brief's activity.
- `deps` — one entry per `depends_on` value, in the order the field
  declared them. Each entry SHALL carry the dep's `change` (name)
  and its `doneness` (`active`, `done`, or `missing`).
- `blocked` — `true` iff any dep's doneness is not `done`.
- `blockedReason` — a one-line summary naming each unsatisfied dep
  and its current doneness. SHALL be omitted (or empty) when
  `blocked` is `false`.

The resolution SHALL NOT confuse the root brief's doneness with
dep satisfaction: a root whose own doneness is `done` MAY still be
listed (e.g. by `minifac briefs`), and its `blocked` value still
reflects the dep doneness rather than its own.

#### Scenario: No deps resolves to not blocked

- **WHEN** `inputs/foo.md` declares `depends_on: []` (or omits the
  field)
- **THEN** `computeBriefState("foo", ...)` returns a result whose
  `deps` is the empty array, `blocked` is `false`, and
  `blockedReason` is omitted or empty

#### Scenario: All deps done resolves to not blocked

- **WHEN** `inputs/foo.md` declares `depends_on: [bar, baz]` and
  both `inputs/done/bar.md` and `inputs/done/baz.md` exist
- **THEN** `computeBriefState("foo", ...)` returns
  `{ doneness: "active", deps: [{change: "bar", doneness: "done"},
    {change: "baz", doneness: "done"}], blocked: false, ... }`

#### Scenario: Dep still active blocks the brief

- **WHEN** `inputs/foo.md` declares `depends_on: [bar]` and
  `inputs/bar.md` exists (not yet moved to `inputs/done/`)
- **THEN** `computeBriefState("foo", ...)` returns a result whose
  `deps` contains `{change: "bar", doneness: "active"}`, `blocked`
  is `true`, and `blockedReason` names `bar` and its doneness

#### Scenario: Missing dep blocks the brief

- **WHEN** `inputs/foo.md` declares `depends_on: [bar]` and neither
  `inputs/bar.md` nor `inputs/done/bar.md` exists
- **THEN** `computeBriefState("foo", ...)` returns a result whose
  `deps` contains `{change: "bar", doneness: "missing"}`, `blocked`
  is `true`, and `blockedReason` names `bar` and its doneness

#### Scenario: Multiple unsatisfied deps all surface in the reason

- **WHEN** `inputs/foo.md` declares `depends_on: [bar, baz, qux]`,
  `inputs/bar.md` exists (active), `inputs/done/baz.md` exists, and
  neither `inputs/qux.md` nor `inputs/done/qux.md` exists
- **THEN** `computeBriefState("foo", ...)` returns a result whose
  `deps` reflects all three with their respective doneness,
  `blocked` is `true`, and `blockedReason` names both `bar`
  (`active`) and `qux` (`missing`)

#### Scenario: Deep dep chain does not transitively block

- **WHEN** `inputs/foo.md` declares `depends_on: [bar]`,
  `inputs/done/bar.md` declares `depends_on: [baz]` (in its
  frontmatter), and `inputs/baz.md` exists (active, not done)
- **THEN** `computeBriefState("foo", ...)` returns `blocked: false`;
  the contract is on the immediate dep, and `bar` is done. The
  transitive state of `baz` does not affect whether `foo` is
  runnable.

### Requirement: Dependency cycle detection

The combined resolution function SHALL detect cycles in the
`depends_on` graph reachable from the root change. A cycle SHALL
cause the resolution to throw `BriefCycleError` whose payload names
the full visited path that closed the cycle. Cycle detection SHALL
walk the graph regardless of doneness (a cycle through a `done`
brief is still a cycle in the schema).

The runner's refusal of blocked briefs (per `run-cli`) SHALL
propagate the cycle error as a usage error (`exit 1`), and the
`--force` flag SHALL NOT bypass cycle detection.

#### Scenario: Direct two-node cycle is detected

- **WHEN** `inputs/foo.md` declares `depends_on: [bar]` and
  `inputs/bar.md` declares `depends_on: [foo]`
- **THEN** `computeBriefState("foo", ...)` throws
  `BriefCycleError` whose payload contains the cycle
  `["foo", "bar", "foo"]` (or equivalent representation)

#### Scenario: Three-node cycle is detected

- **WHEN** `inputs/foo.md` declares `depends_on: [bar]`,
  `inputs/bar.md` declares `depends_on: [baz]`, and `inputs/baz.md`
  declares `depends_on: [foo]`
- **THEN** `computeBriefState("foo", ...)` throws
  `BriefCycleError` whose payload contains the cycle
  `["foo", "bar", "baz", "foo"]`

#### Scenario: Self-loop is detected

- **WHEN** `inputs/foo.md` declares `depends_on: [foo]`
- **THEN** `computeBriefState("foo", ...)` throws
  `BriefCycleError` whose payload contains `["foo", "foo"]`

### Requirement: Runner marks brief done after terminal-success

The runner SHALL execute a mark-done post-step against the worktree
(or in-place cwd, in `--in-place` mode) after observing the
factory's terminal-success status but before recording the run as
`succeeded` in the run store. The post-step SHALL be:

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
  `inputs/<change>.md` remains in `inputs/` and no new commit is
  written

#### Scenario: Brief-less factory run does not invoke mark-done

- **WHEN** a successful run is brief-less (the factory declares
  `brief: "none"` and no brief was resolved)
- **THEN** the runner SHALL NOT invoke the mark-done post-step;
  no `inputs/done/` activity occurs
