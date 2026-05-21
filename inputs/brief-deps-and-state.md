---
change: brief-deps-and-state
factory: sdd
base_branch: main
---

## Background

A [[Brief]] today is just a file in `inputs/` with no observable
state. Auto-mode and human users both need a state model. The
binding decision in
`docs/decisions/0015-Brief-Deps-and-State.md` settles the shape;
**read it first**.

The one-line framing: **git for briefs, sqlite for runs**. Brief
*doneness* lives in git (active = file at `inputs/<name>.md`; done
= file at `inputs/done/<name>.md`). Run *activity* lives in
runs.db (running / succeeded / failed). Dep satisfaction = the
dep's file is in `inputs/done/`.

## What to do

Implement what 0015 describes. Concretely:

### 1. Brief schema

- Add `depends_on: string[]` (default `[]`) to the brief
  frontmatter schema in `src/brief/schema.ts`. Continue to be
  permissive on other unknown extras.
- Update `examples/sample-brief.md` to show `depends_on` with a
  short comment.

### 2. Runs.db migration: `branch_name` column

- Add a new migration file `src/storage/migrations/0002_add_branch_name.sql`
  that ALTERs the `runs` table to add `branch_name TEXT` (nullable
  for rows from existing DBs).
- Mirror the SQL in `src/storage/migrations/index.ts`'s inline
  table (`MIGRATIONS` array) per the existing convention there.
- The runner starts populating `branch_name` when it creates a
  worktree (the branch name the worktree was created on — for v0
  this is still `<change>`; once
  [[0019-Run-Scoped-Branches]] lands it will be
  `run/<change>-<slug>`).
- `minifac runs` / `minifac runs show` and any viewer code that
  surfaces "merge this with..." should use `branch_name` from the
  row.

### 3. Brief doneness derivation (git, not runs.db)

- New module `src/brief/doneness.ts` (or fold into
  `src/brief/state.ts` — your judgment) exposing:

      type Doneness = "active" | "done" | "missing";

      computeBriefDoneness(change: string, opts: { inputsDir, repoRoot }):
        { doneness: Doneness, filePath?: string }

- Resolution: check for `<inputsDir>/<change>.md` (active),
  `<inputsDir>/done/<change>.md` (done), else `missing`.
- This is a pure filesystem check against the caller's repo (the
  one minifac was invoked from). No git operations needed beyond
  the `inputs/` directory layout being committed.

### 4. Brief activity derivation (runs.db)

- New module `src/brief/activity.ts` exposing:

      type Activity = "none" | "running" | "succeeded" | "failed";

      computeBriefActivity(change: string, opts: { runStore }):
        { activity: Activity, mostRecentRunId?: string,
          branchName?: string, endedAt?: number }

- Resolution: query `runs` table for the most recent row matching
  `change = ?`, ordered by `started_at DESC LIMIT 1`. Map its
  `status` to one of the four Activity values. `none` if no rows.

### 5. Combined `computeBriefState` and dep satisfaction

- A wrapper that returns both axes and resolves deps:

      computeBriefState(change, opts):
        { doneness, activity, deps: Array<{ change, doneness }>,
          blocked: boolean, blockedReason?: string }

- `blocked` is true iff any `depends_on` entry has
  `doneness !== "done"`. Cycles in `depends_on` SHALL be detected
  via a visited-set during recursion and surfaced as
  `BriefCycleError`.

### 6. Runner refuses blocked briefs

- Before worktree creation in `minifac run`, compute brief state.
  If `blocked`, exit non-zero with a clear error naming each
  unsatisfied dep and its current doneness (probably `active` or
  `missing`).
- `--force` flag on `minifac run` overrides the block. Document
  as "use when you know what you're doing."

### 7. Minifac marks brief done after factory terminal-success

- After the runner observes the factory's terminal-success status,
  but **before** writing `status = succeeded` to runs.db, the
  runner shells out:

      git mv inputs/<change>.md inputs/done/<change>.md
      git -C <worktree-path> commit -m "Mark <change> done"

  on the worktree's branch.
- If `inputs/done/` doesn't exist in the worktree (first time the
  repo has a done brief), create it.
- If the `git mv` or commit fails (existing uncommitted changes,
  hook rejection, etc.), log a warning, still record the run as
  `succeeded`. Don't fail the run for a post-step failure.
- The factory's nodes (including the SDD archive node) are
  unchanged — they have no responsibility for the move.

### 8. New CLI command `minifac briefs`

- `src/cli/briefs.ts` implementing the subcommand:

      minifac briefs [options]
        --state <s>          filter by doneness (active | done | missing)
        --activity <s>       filter by activity (none | running | succeeded | failed)
        --ready              shorthand: active + no in-flight run + no recently-succeeded + deps done
        --json               stable JSON output
        --inputs <d>         override default inputs dir

- Default output: compact table with columns
  `change`, `state`, `activity`, `deps_summary` (e.g. `2/3 done`),
  `last_run` (id + branch + ended_at if any).

### 9. Tests

- `computeBriefDoneness` covering: active, done, missing.
- `computeBriefActivity` covering: none, running, succeeded,
  failed (with the appropriate row in a fake `RunStore`).
- `computeBriefState` covering: not blocked, blocked-by-active,
  blocked-by-missing, blocked-by-multiple, deep dep chain,
  cycle detection.
- The runner's mark-done post-step: success path
  (file moved, commit lands); already-in-done path
  (idempotent — no-op or skip); git-error path
  (warning logged, run still succeeded).
- `minifac run` refusing blocked briefs; `--force` overrides.
- `minifac briefs` output stability (table + JSON).
- All existing 332+ tests still pass.

### 10. Specs

- NEW capability `brief-state` covering the doneness rule, the
  activity rule, dep satisfaction, cycle detection, the runner's
  mark-done post-step, the refusal of blocked briefs, and
  `minifac briefs`.
- `run-cli`: MODIFIED requirement to add the `briefs` subcommand
  and the `--force` flag on `run`.
- `brief-schema`: MODIFIED requirement to add `depends_on` as a
  known optional field.
- `run-storage`: MODIFIED requirement to add `branch_name` column;
  add scenario covering the `0002_*.sql` migration.

When MODIFYING, copy the entire requirement block from
`openspec/specs/<capability>/spec.md`; do not partial-paste.

### 11. Documentation

- Update `docs/concepts/Brief.md`'s Lifecycle section to describe
  the two-axis model (doneness in git, activity in runs.db).
- Mention `inputs/done/` as the destination for completed briefs.
- Add a short section to `examples/sdd.md` or the README showing
  the authoring of dependent briefs.
- Update `docs/Open-Questions.md`: remove the "Brief dependencies
  and state" entry (resolved by this change). Leave the
  "Prune leaves orphaned branches behind" entry — it's still
  active until run-scoped-branches lands.

## Out of scope

- **Run-scoped branch naming** (`run/<change>-<slug>`). Separate
  proposal ([[0019-Run-Scoped-Branches]]). For this change, the
  `branch_name` column is populated with whatever the current
  branch-naming scheme produces (today: just `<change>`).
- **`factory:` override at invocation** (`minifac run X
  --factory Y`). Separate proposal.
- **`priority` field on briefs.** Future enhancement.
- **Auto-mode itself.** This change provides the `ready` predicate;
  auto-mode consumes it.
- **Beads / external state stores.**
- **Studio surfacing of brief state.** CLI only here.

## Acceptance criteria

- A brief with `depends_on: [other]` parses cleanly through the
  loader
- A brief whose dep file is in `inputs/done/` is *not* blocked
- A brief whose dep file is in `inputs/` (or missing) *is* blocked
- A dependency cycle is detected and rejected with a clear error
- `minifac run <blocked-brief>` exits non-zero naming unsatisfied
  deps; `--force` overrides
- After a successful factory run, the brief file is moved to
  `inputs/done/<change>.md` on the worktree's branch, committed
  via a minifac-authored commit
- The mark-done step failing produces a warning but doesn't
  fail the run
- `minifac briefs` lists briefs across both axes;
  `--state` / `--activity` / `--ready` filter as documented;
  `--json` is stable
- The runs.db migration adds `branch_name` cleanly to an existing
  DB; new runs populate the column
- All existing tests pass; new tests cover both axes + the
  mark-done post-step
- `docs/Open-Questions.md` no longer has the "Brief dependencies
  and state" entry
