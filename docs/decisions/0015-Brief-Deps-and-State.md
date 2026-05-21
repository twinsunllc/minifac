---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0015: Brief state — git for briefs, sqlite for runs

## Context

A [[Brief]] today is just a file in `inputs/`. Beyond "the file
exists," there's no observable state — no way to see what's queued,
ready, blocked, or done across a backlog, and no way to express
dependencies between briefs. The Open-Questions entry "Brief
dependencies and state" has been waiting for the runs.db layer to
land, which it now has (see [[0011-SQLite-for-Runs]]).

Auto-mode (see [[0016-Auto-Mode]]) needs a `ready` predicate. Human
users with more than a handful of briefs benefit from being able to
see the backlog at a glance. Both need a state model.

An earlier iteration of this decision tried to model brief state as
a single derived value (pending / running / succeeded / failed /
blocked / merged / missing) computed from file existence + the most
recent run's outcome + git reachability of the run's branch. That
collapsed two different concerns:

1. **Has this brief been completed?** A shared, durable, team-visible
   assertion. Needs to live somewhere everyone (including future
   machines) can see.
2. **What's happening on this machine right now?** Per-run activity:
   in flight, last attempt failed, last attempt succeeded but
   awaiting review. Machine-local, ephemeral.

These have different audiences and different durability requirements,
and packing them into one state value made the semantics murky.

## Decision

**Two axes, two storage layers:**

- **Brief doneness lives in git.** A brief is `active` if its file is
  at `inputs/<name>.md`; `done` if it's at `inputs/done/<name>.md`;
  `missing` if neither exists. That's the entire doneness vocabulary.
- **Run activity lives in [[Runs-DB]].** Each run row records what
  happened on this machine: status (`running` / `succeeded` /
  `failed`), timestamps, the branch the worktree was on. That's the
  entire activity vocabulary.

The framing in one line: **git for briefs, sqlite for runs.**

### `depends_on` in brief frontmatter

```yaml
---
change: serve-and-viewer
factory: sdd
depends_on: [factory-inputs-core, worktree-mode]
---
```

Loader (already permissive-on-extras per [[0005-Brief-Schema]]) starts
treating `depends_on` as known: typed as `string[]`, default `[]`.
Other unknown fields stay permissive.

### Dep satisfaction = doneness in git

A dep is satisfied iff `inputs/done/<dep>.md` exists in the calling
repo's `main` branch (or whatever the default branch is). Strictly
"done" (merged), not "the factory ran successfully on this machine."

This is the right rule because:

- It's team-shareable — collaborator A's merge of dep X means
  collaborator B's downstream brief becomes runnable, without any
  state-sync ceremony
- It matches what "depends on" actually means — building on
  unmerged-and-possibly-rejected work is the wrong default
- It admits manual completion — `git mv inputs/foo.md inputs/done/foo.md`
  on main marks foo done without ever running the factory

### Run activity in runs.db

The existing `runs` table from [[0011-SQLite-for-Runs]] already
covers the activity axis: `status` ∈ {`running`, `succeeded`,
`failed`}, plus timestamps, factory, change, etc.

One small schema addition is justified by [[0019-Run-Scoped-Branches]]
(forthcoming): add `branch_name TEXT` to the `runs` table so the
viewer and CLI can show "merge this with `git merge <branch>`"
without parsing it back out of git. That addition ships as migration
`0002_*.sql` in the migrations layer.

### Minifac marks the brief done — not the factory

After a factory's terminal node emits `succeeded`, **minifac itself**
appends a commit to the worktree's branch:

```
git mv inputs/<change>.md inputs/done/<change>.md
git commit -m "Mark <change> done"
```

This runs as a post-step in the runner, after terminal-success
is observed and before the run is recorded as `succeeded` in
runs.db. The factory has no responsibility for the move; it just
does its work. This keeps "mark brief done" a uniform minifac
contract independent of which factory ran.

If the mark-done commit fails (some git error), the run is still
recorded as `succeeded` — the factory work succeeded — but a
warning is surfaced. The user can `git mv` manually.

### Cycles in `depends_on`

Cycles SHALL be detected at brief load time and rejected with a
clear error naming the cycle (mirrors the factory cycle check).

### The runner refuses to execute a brief with unsatisfied deps

Clear error listing which deps are still in `inputs/<name>.md`
rather than `inputs/done/<name>.md`. `--force` overrides for the
user who knows what they're doing.

### `minifac briefs` CLI

Lists briefs across both axes:

```
foo    active   awaiting-review (run 8493c26 on branch run/foo-8493)
bar    active   pending
baz    active   running (run a7b3...)
zap    active   failed (run 91dd, 2 days ago)
qux    done     —
```

Flags: `--state <s>` filters on doneness; `--activity <s>` filters
on run-state; `--ready` shows briefs that are `active`, deps
satisfied, no in-flight or recently-succeeded run; `--json` for
piping.

## Consequences

- The state model is two simple axes that compose rather than one
  large machine. Easier to reason about, easier to test.
- "Done" is git-state, shared across all collaborators on the repo.
  Two machines pulling main see the same set of done briefs.
- Run activity is per-machine — appropriate for "I have a run going
  right now" — but irrelevant to whether someone else's checkout
  considers the brief done.
- Manual completion works (`git mv` + merge marks done without a
  factory run). Useful for briefs you abandoned, prototypes that
  shipped via another route, etc.
- The factory-vs-minifac boundary becomes explicit: factory does
  factory work; minifac asserts brief doneness. No per-factory
  implementation of the file-move.
- Auto-mode's `ready` predicate becomes: brief at `inputs/<name>.md`,
  no in-flight run, no recently-succeeded-not-yet-merged run, all
  deps at `inputs/done/<dep>.md`.

## Alternatives considered

- **Single derived state per brief** (the earlier seven-state
  machine: pending / running / succeeded / failed / blocked /
  merged / missing). Rejected — conflated doneness with activity;
  required git reachability checks for `merged`; per-machine
  runs.db drove a team-shared concept.
- **Done-ness in runs.db.** Rejected — per-machine; doesn't transfer
  to other collaborators without sync ceremony.
- **Done-ness in brief frontmatter** (e.g. `completed: <date>`).
  Rejected — mutates the brief file; less explicit than directory
  location; conflicts with "the brief is the original ask."
- **Delete the brief on merge.** Rejected — loses the historical
  record of what was authored. Moving to `inputs/done/` keeps the
  content readable.
- **Factory archives the brief.** Rejected — every factory would
  need to implement; easy to forget; "brief doneness" is a
  minifac-level concern.
- **`depends_on` lives on factories, not briefs.** Rejected —
  factories are infrastructure; "this change depends on that
  change" is per-change data.
- **Auto-retry failed deps before computing downstream state.**
  Rejected — silent retries defeat the SDD model.

## Related

- [[Brief]] — gains `depends_on` field, lives in `inputs/` or
  `inputs/done/`
- [[Runs-DB]] — activity axis; gains `branch_name` column via
  `0002_*.sql` migration
- [[0005-Brief-Schema]] — permissive-extras made `depends_on`
  available
- [[0011-SQLite-for-Runs]] — runs.db where activity persists; has
  the migration system this change extends
- [[0016-Auto-Mode]] — consumer of the `ready` predicate
- [[0019-Run-Scoped-Branches]] — forthcoming; introduces
  `branch_name` and the `run/<change>-<slug>` naming this depends
  on for "merge this with..." UX
- [[Open-Questions]] — removes "Brief dependencies and state"
