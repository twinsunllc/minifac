---
change: brief-deps-and-state
factory: sdd
base_branch: main
---

## Background

The [[Brief]] today is a file in `inputs/` with no observable state
beyond "the file exists." With [[Runs-DB]] persisting run history,
state can be derived (file + most-recent run + recursive dep
satisfaction). The Open-Questions entry "Brief dependencies and
state" has been queued for exactly this moment.

Read `docs/decisions/0015-Brief-Deps-and-State.md` for the binding
decision. The shape is settled — schema field, state machine, derived
not stored, cycle detection, refusal to schedule blocked briefs, new
CLI command.

## What to do

Implement what 0015 describes. Concretely:

### 1. Brief schema

- Add `depends_on: string[]` to the brief frontmatter schema in
  `src/brief/schema.ts`. Default `[]`. Continue to be permissive on
  unknown extras for other future fields.
- Update `examples/sample-brief.md` to show `depends_on` with a brief
  comment about what it does.

### 2. State derivation

- New module (probably `src/brief/state.ts`) exposing:

      computeBriefState(change: string, opts: { runStore, inputsDir })
        → { state, reason?, deps: Array<{ change, state }> }

  The function computes a brief's state from: file existence at
  `<inputsDir>/<change>.md`, the most recent run for that change in
  the [[Runs-DB]], and recursive `computeBriefState` calls for each
  entry in `depends_on`.
- Memoize per-call (don't recompute the same brief twice in one
  traversal). Detect cycles via a visited-set in the traversal.
- Cycles are rejected with a clear error naming the cycle. This is
  exposed as `class BriefCycleError extends Error`.
- The state set is exactly the six values in 0015: `pending`,
  `running`, `succeeded`, `failed`, `blocked`, `missing`.

### 3. Runner refuses to run a blocked brief

- `src/cli.ts` (or wherever `minifac run` dispatch lives), before
  starting the [[Worktree]] and the run, computes the brief's
  state. If `blocked`, exit non-zero with an error listing which
  deps aren't satisfied (and their states).
- `missing` deps cause `blocked` at the parent level; the error
  message should distinguish "blocked because dep X is in state Y"
  from "blocked because dep X is missing."
- `--force` flag on `minifac run` SHALL override the block (escape
  hatch for the user who knows what they're doing). Use sparingly;
  documented as such.

### 4. New CLI command `minifac briefs`

- `src/cli/briefs.ts` implementing the subcommand:

      minifac briefs [options]
        --state <s>    filter by state
        --ready        only schedulable (pending + all deps succeeded)
        --json         emit JSON
        --inputs <d>   override default inputs dir

- Default output: a compact table with columns `change`, `state`,
  `factory`, `deps_summary` (e.g. `2/3 ready`), `last_run`.
- `--json` emits an array of state objects. Stable shape for piping
  into other tools (and for [[Auto-Mode]] later).

### 5. Tests

- Unit tests for `computeBriefState` covering: pending, running,
  succeeded, failed (with each preceding state of the most recent
  run), blocked (with each non-succeeded dep state), missing,
  cycle detection.
- Tests for `minifac run` refusing blocked briefs (with a fake
  `RunStore` and synthetic brief files).
- Tests for `minifac briefs` output format (both table and JSON).
- All existing tests still pass.

### 6. Specs

- NEW capability `brief-state` (or fold into `brief-schema` — your
  judgment) covering the schema field, the state-derivation rules,
  cycle detection, and the runner's refusal contract. Scenarios for
  each state plus cycle rejection.
- `run-cli`: MODIFIED requirement to add the `briefs` subcommand and
  the `--force` flag on `run`.
- `brief-schema`: MODIFIED requirement to add `depends_on` as a
  known optional field. Note that loader is still permissive on
  other extras.

When MODIFYING, copy the entire requirement block from
`openspec/specs/<capability>/spec.md`; do not partial-paste.

### 7. Documentation

- Update `docs/concepts/Brief.md` Lifecycle section to describe the
  six states and the derivation.
- Add a small section to `examples/sdd.md` or the README showing the
  authoring of dependent briefs.
- Update `docs/Open-Questions.md`: remove the "Brief dependencies
  and state" entry (resolved by this change).

## Out of scope

- **Stored state in runs.db.** State stays derived. Performance work
  (caching, indexing) is deferred until proven necessary.
- **`priority` field on briefs.** Future enhancement; not here.
- **Auto-mode itself.** This change just provides the `ready`
  predicate; [[0016-Auto-Mode]] is the next dogfood.
- **Beads / external state stores.** Trigger still hasn't fired.
- **UI surfaces.** Briefs list is CLI only here; studio is its own
  project.

## Acceptance criteria

- A brief with `depends_on: [other-change]` parses cleanly through
  the loader
- `computeBriefState` returns each of the six documented states
  correctly given representative inputs
- A dependency cycle is detected and rejected with a clear error
- `minifac run <blocked-brief>` exits non-zero with an error naming
  unsatisfied deps; `--force` overrides
- `minifac briefs` lists briefs and their states; `--ready` filters
  correctly; `--json` is stable
- All existing tests pass; new tests cover the state-derivation
  matrix
- `docs/Open-Questions.md` no longer has the "Brief dependencies
  and state" entry
