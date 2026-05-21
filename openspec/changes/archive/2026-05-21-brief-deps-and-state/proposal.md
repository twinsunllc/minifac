## Why

A [[Brief]] today is just a file in `inputs/`. There is no way to ask
"what's queued, what's blocked, what's done" across a backlog, and no
way to express dependencies between briefs. [[Auto-Mode]] needs a
`ready` predicate; humans with more than a handful of briefs need
backlog visibility. Both need a state model.

Decision
[`0015-Brief-Deps-and-State`](../../../docs/decisions/0015-Brief-Deps-and-State.md)
pins the shape: two axes, two storage layers — **git for briefs,
sqlite for runs**. A brief's *doneness* is its directory location
(`inputs/<name>.md` = active; `inputs/done/<name>.md` = done); a
brief's *activity* is the most recent row for that change in
[[Runs-DB]] (`none / running / succeeded / failed`). Dep satisfaction
is "the dep's file is in `inputs/done/`" — strictly merged, not
"the factory ran successfully on this machine." Manual completion
works without ceremony (`git mv inputs/foo.md inputs/done/foo.md`).

[`0019-Run-Scoped-Branches`](../../../docs/decisions/0019-Run-Scoped-Branches.md)
has already landed, so the `branch_name` column and per-run branch
naming are in place. This change builds on that and provides the
state model the next phase ([[0016-Auto-Mode]]) consumes.

## What Changes

- **NEW** `depends_on: string[]` (default `[]`) is a known optional
  field in the brief frontmatter. Other unknown extras remain
  permissive.
- **NEW** brief *doneness* derivation: a pure filesystem check
  resolving to `active` (file at `inputs/<name>.md`), `done` (file at
  `inputs/done/<name>.md`), or `missing` (neither). No git operations
  beyond the `inputs/` layout being committed.
- **NEW** brief *activity* derivation: the most recent `runs` row
  matching `change = ?` (`none / running / succeeded / failed`).
- **NEW** combined `computeBriefState` that returns both axes,
  resolves `depends_on` recursively, detects dependency cycles, and
  reports whether the brief is `blocked` (any dep `doneness !== "done"`).
- **NEW** runner refuses to execute blocked briefs. `minifac run`
  exits non-zero before worktree creation, naming each unsatisfied
  dep. A `--force` flag overrides for the user who knows what they
  are doing.
- **NEW** minifac itself marks the brief done after the factory's
  terminal-success status, but before recording `succeeded` in
  runs.db. Shells out: `git mv inputs/<change>.md
  inputs/done/<change>.md` followed by a minifac-authored commit on
  the worktree's branch. Failures log a warning but do not fail the
  run. Factory nodes (including the SDD archive node) are unchanged.
- **NEW** `minifac briefs` CLI subcommand. Lists briefs across both
  axes with `--state`, `--activity`, `--ready`, `--json`, and
  `--inputs <d>` filters. Default output is a compact table with
  columns `change`, `state`, `activity`, `deps_summary`, `last_run`.
- **MODIFIED** `brief-schema` capability: `depends_on` joins the
  known-optional set; loader stays permissive on other extras.
- **MODIFIED** `run-cli` capability: `--force` flag on `run`, plus
  the new `briefs` subcommand.

## Impact

- **Affected specs**:
  - NEW capability `brief-state` covering the doneness rule, the
    activity rule, dep satisfaction, cycle detection, the runner's
    mark-done post-step, the refusal of blocked briefs, and the
    `minifac briefs` subcommand.
  - `brief-schema` (MODIFIED): `depends_on` joins the known-optional
    fields with a `string[]` type and `[]` default.
  - `run-cli` (MODIFIED): `--force` flag on `run`; `minifac briefs`
    subcommand.

- **Affected code**:
  - `src/brief/schema.ts`: add `depends_on` to
    `BriefFrontmatterSchema` as an optional array of non-empty
    strings.
  - `src/brief/doneness.ts` (NEW): `Doneness` type +
    `computeBriefDoneness`.
  - `src/brief/activity.ts` (NEW): `Activity` type +
    `computeBriefActivity`.
  - `src/brief/state.ts` (NEW): combined `computeBriefState` with
    dep traversal and `BriefCycleError`.
  - `src/cli/resolve.ts` (existing run-action wiring): compute brief
    state before worktree creation; refuse on blocked-without-force.
  - `src/runner/run.ts` (or a new `src/runner/mark-done.ts`): after
    terminal-success and before runs.db `succeeded`, run the `git mv`
    + commit; on failure, log warning and still record `succeeded`.
  - `src/cli/briefs.ts` (NEW) + wiring in `src/cli.ts`.
  - `examples/sample-brief.md`: add a commented `depends_on` example.

- **Affected docs**:
  - `docs/concepts/Brief.md`: lifecycle section rewritten around the
    two-axis model; `inputs/done/` documented as the destination for
    completed briefs.
  - `examples/sdd.md` or the README: short section on authoring
    dependent briefs.
  - `docs/Open-Questions.md`: confirm the "Brief dependencies and
    state" entry is gone (already removed in a prior change; this
    change closes the loop).

- **Out of scope**:
  - Run-scoped branch naming and the `branch_name` column (already
    landed in [`0019-Run-Scoped-Branches`](../../../docs/decisions/0019-Run-Scoped-Branches.md)).
  - `factory:` override at invocation (separate proposal
    [`0020-Factory-Override-At-Invocation`](../../../docs/decisions/0020-Factory-Override-At-Invocation.md)).
  - `priority` field on briefs.
  - [[Auto-Mode]] itself — this change provides the `ready` predicate;
    auto-mode consumes it.
  - Beads / external state stores.
  - Studio surfacing of brief state. CLI only here.

- **No new runtime dependencies.** The mark-done step shells out to
  `git`, same family of calls already used for worktree creation.
