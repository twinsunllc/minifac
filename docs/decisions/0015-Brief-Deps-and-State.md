---
status: accepted
date: 2026-05-20
supersedes: []
superseded-by: null
tags: [decision]
---

# 0015: Brief dependencies and computed state

## Context

Today a [[Brief]] is just a file in `inputs/`. Beyond "the file exists,"
there's no observable state — no way to see what's queued, ready,
blocked, or done across a backlog. The Open-Questions entry "Brief
dependencies and state" has been waiting for the runs.db layer to
land, which it now has (see [[0011-SQLite-for-Runs]]). Auto-mode
(forthcoming, see [[0016-Auto-Mode]]) needs a `ready` predicate to
query, and human users with more than a handful of briefs benefit
from being able to see the backlog at a glance.

## Decision

**`depends_on`** becomes a canonical optional field in brief frontmatter:

```yaml
---
change: serve-and-viewer
factory: sdd
depends_on: [factory-inputs-core, worktree-mode]
---
```

The brief loader (already permissive-on-extras per
[[0005-Brief-Schema]]) starts treating `depends_on` as known: typed
as `string[]`, default `[]`. Other unknown fields stay permissive.

**Brief state is computed, not stored.** A brief's state is derived
on demand from three sources: the brief file's existence, the most
recent matching run in [[Runs-DB]], and the recursive state of each
`depends_on` entry. States:

- `pending` — file exists, no completed run; ready to schedule if deps
  are all `succeeded`
- `running` — there's an active run in runs.db for this change
- `succeeded` — most recent run for this change terminated with
  `status: succeeded`
- `failed` — most recent run terminated with `status: failed`
- `blocked` — at least one `depends_on` entry is not `succeeded` (it's
  `pending`, `running`, `failed`, or `blocked` itself)
- `missing` — referenced by another brief's `depends_on` but the file
  doesn't exist (surface as an error when computed for the referencing
  brief)

**Cycles in the dependency graph** SHALL be detected at brief load
time and rejected with a clear error naming the cycle (mirrors the
factory cycle check).

**The runner refuses to execute a `blocked` brief** with a clear
error listing which deps aren't satisfied.

**New CLI command `minifac briefs`** lists briefs with their state.
Flags: `--state <s>` filters; `--ready` shows only schedulable;
`--json` for piping. Similar shape to `minifac runs`.

## Consequences

- The backlog becomes inspectable from the terminal and (eventually)
  the studio
- [[Auto-Mode]] gets the `ready` predicate it needs without any
  schema surgery — just "give me all briefs whose computed state is
  `pending` AND all `depends_on` are `succeeded`"
- No new persisted state means no migration risk and no consistency
  bugs from drift between brief file and stored state
- Performance: state computation is O(deps) per brief; for any
  realistic backlog this is fine. If it becomes slow at scale, cache
  per-process; don't introduce a stored state column.
- Failed deps don't auto-unblock — once a dep is `failed`, downstream
  briefs stay `blocked` until the user reruns the failed dep. This
  matches the SDD spirit: failure is a signal to think, not to retry
  blindly.

## Alternatives considered

- **Store state explicitly in runs.db.** Rejected — derived state has
  no consistency risk and is fast enough at v0 scale. Storage would
  add a "what if the row drifts from reality" failure mode for no
  current benefit.
- **`depends_on` lives on factories, not briefs.** Rejected —
  factories are infrastructure; "this change depends on that change"
  is per-change data, which belongs in the brief.
- **Auto-retry failed deps before computing downstream state.**
  Rejected — silent retries defeat the SDD model.
- **Use beads for backlog state** (per the Open-Questions deferred
  item). Rejected — the SQLite-derived state covers v0 needs. Beads
  earns its way in only if richer issue-tracker semantics (threaded
  comments, assignees) become important.

## Related

- [[Brief]] — gains `depends_on` field
- [[Runs-DB]] — state-derivation source
- [[0005-Brief-Schema]] — permissive-extras made this slot available
- [[0011-SQLite-for-Runs]] — schema is shaped for this
- [[0016-Auto-Mode]] — the consumer of `ready` state
- [[Open-Questions]] — removes the "Brief dependencies and state" entry
