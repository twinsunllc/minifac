## Why

When an autorun child run is killed mid-flight (second `q`, `--force`,
SIGHUP, terminal close, OS kill, crash), its `runs.db` row is left at
`status='running'`. The next autorun cycle computes
`activity: 'running'` for the affected brief and skips it with reason
`activity-running`. The brief stays silently blocked until a human
edits the database row by hand. The skip is also indistinguishable
from a brief that is legitimately in flight elsewhere (another
autorun instance, a manual `minifac run`, the daemon).

The existing per-change lockfile already knows the difference: a live
PID holds it while a real run is in flight, and `unlink` at run-end
makes the file disappear on graceful exit. Use it as the liveness
oracle, reconcile orphans lazily on the scheduler's next pass, and
emit a distinct skip reason for the legitimately-busy case so the TUI
(and operators) can tell them apart.

## What Changes

- Scheduler probes the per-change lockfile whenever a brief's
  most-recent `runs.db` row is `status='running'`.
- Lockfile missing OR PID dead → reconcile: flip the `runs.db` row
  to `status='failed'` with reason `orphaned`, then schedule the
  brief normally on the same poll cycle.
- Lockfile present AND PID live (or EPERM, which the existing live
  probe treats as live) → skip with new reason `running-elsewhere`,
  not `activity-running`.
- Runner ordering invariant: the terminal `runs.db` row write
  (`finalizeRun`) SHALL happen BEFORE the per-change lockfile is
  unlinked. This makes "lockfile missing + row still running" an
  unambiguous orphan signature; a graceful exit can never produce
  that combination.
- `activity-running` is replaced by `running-elsewhere` in the
  autorun event reason enum; the old value is no longer emitted by
  the scheduler.

## Capabilities

### New Capabilities

(none — this change extends existing capabilities)

### Modified Capabilities

- `auto-mode`: scheduler reconciles orphaned runs lazily; the skip
  reason enum loses `activity-running` and gains
  `running-elsewhere`.
- `worktree-management`: codifies the runner's exit ordering — the
  terminal `runs.db` row write SHALL precede the per-change
  lockfile release.

## Impact

- `src/cli/autorun-scheduler.ts`: probe the lockfile before
  skipping with the running-activity case; add reconciliation that
  updates the `runs.db` row and proceeds to schedule.
- `src/worktree/lock.ts` (or sibling): expose a small helper
  `probeChangeLiveness(change, factory)` that returns
  `{ orphaned: true } | { running: true, pid: number }`.
- `src/runtime/runFactory.ts` (and/or wherever the run-end sequence
  lives): reorder finalization so `finalizeRun` resolves before the
  lockfile `unlink` runs.
- Test surface: new scheduler unit tests for both reconciliation
  paths; new integration test asserting the runner's
  finalize-before-unlock ordering.
- No `runs.db` schema change; the new reason strings (`orphaned`,
  `running-elsewhere`) fit the existing `runs.reason` TEXT column.
- No new on-disk state, no new daemon flags, no TUI changes (the
  existing render of `runs.db` row transitions already surfaces the
  reconciled `failed` state).
