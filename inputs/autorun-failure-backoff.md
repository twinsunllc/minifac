---
change: autorun-failure-backoff
factory: sdd
base_branch: main
---

## Background

`minifac autorun`'s scheduler retries failed briefs
indefinitely — `activity === "failed"` is not a skip
condition in `src/cli/autorun-scheduler.ts:147-150`. A brief
with a real bug (malformed frontmatter, an always-failing
verify gate, a test the model can't fix) gets dispatched on
every poll cycle, burning compute on a known-broken loop
until the operator notices.

The binding decision is at
`docs/decisions/0031-Autorun-Failure-Backoff.md`. Read it
first. Key calls locked:

- **Per-session in-memory counter.** No persistent state.
  Restart = fresh slate.
- **Default cap: 3 failures per change per session.**
- **New CLI flag**: `--max-failures <n>` (default `3`;
  `0` opts out).
- **New skip reason**: `failure-cap` joining the existing
  enum.
- The cap applies only to *node-side* failures (`node_failed`,
  `graph_drained`, `budget_exhausted`, `sentinel_failed`,
  `missing_required_output` — when [[0027-Node-Outputs]]
  lands). It does **not** count `user_quit` (the autorun
  process was killed) toward the cap.

## What to do

### 1. CLI flag

Add `--max-failures <n>` to `minifac autorun` in `src/cli.ts`:

```typescript
.option("--max-failures <n>", "Per-session failure cap per change; 0 to disable", "3")
```

Parse to a non-negative integer; reject negative values
with a clear error.

### 2. Scheduler state

Extend the scheduler's internal state in
`src/cli/autorun-scheduler.ts`:

```typescript
private readonly failureCounts: Map<string, number> = new Map();
private readonly maxFailures: number;
```

Set `maxFailures` from the resolved options.

### 3. Counter increment

When a dispatched run completes with `status: "failed"` and
a non-`user_quit` reason, increment the counter for that
brief's `change` name. Counter ops happen in the scheduler's
existing post-run handler — find the place that releases the
in-flight slot and add the increment there.

Capping reason categorization:
- Counts toward cap: `node_failed`, `graph_drained`,
  `budget_exhausted`, `sentinel_failed`,
  `missing_required_output` (once [[0027-Node-Outputs]]
  lands)
- Does NOT count toward cap: `user_quit` (process killed)

If the result has no reason or the reason is unfamiliar,
default to counting it (safer).

### 4. Decide-time check

In `decide()`, add the cap check before the concurrency check:

```typescript
const failureCount = this.failureCounts.get(change) ?? 0;
if (this.maxFailures > 0 && failureCount >= this.maxFailures) {
  return {
    action: "skip",
    reason: "failure-cap",
    brief,
    detail: `${failureCount}/${this.maxFailures}`,
  };
}
```

The check is gated by `maxFailures > 0` so `--max-failures 0`
disables the feature entirely.

### 5. SkipReason enum extension

Add `failure-cap` to `SkipReason` in
`src/cli/autorun-scheduler.ts`:

```typescript
export type SkipReason =
  | "blocked"
  | "concurrency"
  | "failure-cap"      // NEW
  | "filtered"
  | "in-flight"
  | "activity-running"
  | "activity-succeeded"
  | "done";
```

Make sure existing consumers of `SkipReason` (logger,
JSON-emit, possibly tests) handle the new value gracefully.

### 6. Logging

When a brief is skipped for `failure-cap`, emit a log line
that names the count and how to recover:

**Raw mode:**
```
[autorun] skipped <change>: failure cap reached (3/3); restart autorun to retry
```

**JSON mode:**
```json
{"kind":"skipped","ts":...,"change":"<change>","reason":"failure-cap","detail":"3/3"}
```

The log helper that already exists for other skip reasons
should be extended — search for `kind: "skipped"` in
autorun.ts and add the new case.

### 7. Tests

Cover at least:

- Counter increments on a failed dispatch with a node-side
  reason
- Counter does NOT increment on a `user_quit` failure
- Brief is skipped with `failure-cap` after `maxFailures`
  consecutive failures
- `--max-failures 0` disables the feature (no skip)
- `--max-failures 5` allows 5 failures, then caps
- Restart (new scheduler instance) starts with an empty
  counter map — i.e., previously-capped briefs are
  dispatched again on a fresh autorun
- Per-change isolation: a cap on change A does not affect
  change B
- Filter / blocked / done / activity-* skip reasons still
  short-circuit before the cap check (correct precedence)

### 8. Concept doc

Update `docs/concepts/Auto-Mode.md` with a "Failure cap"
section covering:

- The default behavior
- How to override with `--max-failures`
- The "restart to reset" gesture
- Which failure reasons count

### 9. CLI reference

Update `docs/CLI.md` autorun section:

- Add `--max-failures <n>` to the options table
- Add `failure-cap` to any skip-reason discussion
- Mention in the description that the cap exists and how
  to reset

### 10. Spec deltas

`autorun` capability: MODIFY existing requirements to
describe the failure-cap behavior. ADD a scenario covering
the cap firing after N consecutive failures, and another
covering the `--max-failures 0` opt-out.

## Out of scope

- Persistent failure state across autorun restarts
- Exponential time-based back-off
- Reset on brief file modification (file hash detection)
- Per-brief `max_failures` override in frontmatter
- A "reset cap for change X" CLI command
- Counting `running` (timed-out) runs toward the cap

## Acceptance criteria

- `minifac autorun --max-failures <n>` flag works; default
  `3`; `0` disables
- After N consecutive failures (non-`user_quit`) of the same
  change in one session, the scheduler skips with reason
  `failure-cap`
- Clear log line both in raw and JSON modes
- Restart of autorun resets the counter (fresh in-memory map)
- Existing skip reasons still take precedence where they
  apply
- All existing tests pass
- Concept doc + CLI reference reflect the new behavior
