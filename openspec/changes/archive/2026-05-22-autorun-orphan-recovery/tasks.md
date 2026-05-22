## 1. Lockfile liveness probe helper

- [x] 1.1 Add a probe helper (alongside `claim`/`release` in
  `src/worktree/lock.ts` or a sibling module) that takes the
  lockfile-key inputs (`change`, `factory`, repo-hash resolver as
  needed) and returns `{ orphaned: true } | { running: true, pid:
  number }`, treating EPERM as live per the existing
  `isLivePid` semantics.
- [x] 1.2 Surface I/O / parse errors as a discriminated third arm
  (e.g. throwing or returning a structured error) so the scheduler
  can degrade to the running-elsewhere skip safely.
- [x] 1.3 Unit tests for the probe: missing file, present file with
  live PID, present file with dead PID, present file with
  unparseable PID, EPERM (mocked).

## 2. Runner finalize-before-unlock ordering

- [x] 2.1 Locate the run-end sequence (`src/runtime/runFactory.ts`
  and/or sibling) and reorder so the `RunStore.finalizeRun` write
  resolves before the lockfile `unlink` is issued.
- [x] 2.2 Ensure the ordering holds on the failure path and when
  `finalizeRun` itself rejects (release still runs in `finally` so
  the lock does not leak).
- [x] 2.3 Integration test that asserts the ordering: inject a
  store wrapper that records the wall-clock timestamp of
  `finalizeRun` resolution and the lockfile `unlink` call, then
  assert `finalizeAt <= unlinkAt` across success and failure paths.

## 3. Scheduler orphan reconciliation

- [x] 3.1 In `src/cli/autorun-scheduler.ts`, when about to skip a
  brief because its most-recent `runs` row is `status='running'`,
  call the probe helper from task 1.
- [x] 3.2 On the orphan branch: update the `runs` row to
  `status='failed'`, `reason='orphaned'`, populate `ended_at` if
  null, then proceed to schedule the brief through the usual
  readiness / dependency / filter / in-flight / concurrency
  evaluation.
- [x] 3.3 On the running-elsewhere branch: emit a `skipped` event
  with `reason='running-elsewhere'`; do not touch the `runs` row.
- [x] 3.4 Remove `activity-running` from the scheduler's emitted
  reason set and update the autorun event type / structured-log
  reason enum to add `running-elsewhere`.
- [x] 3.5 Probe errors fall back to the running-elsewhere skip path
  without aborting the poll cycle.

## 4. Scheduler unit tests

- [x] 4.1 Faked stale lock (probe returns `{ orphaned: true }`):
  assert the row flip to `failed`/`orphaned`/`ended_at` and that
  the brief is then scheduled on the same poll cycle.
- [x] 4.2 Faked live lock (probe returns `{ running: true, pid }`):
  assert the row is untouched and the emitted skip event carries
  `reason='running-elsewhere'`.
- [x] 4.3 Orphan reconciled but brief has unsatisfied deps: assert
  the row was flipped AND a `skipped` event with `reason='blocked'`
  was emitted (no scheduling).
- [x] 4.4 Probe error path: assert the brief is skipped with
  `reason='running-elsewhere'`, the row is untouched, and the poll
  continues for other briefs.
- [x] 4.5 Ensure no test in the suite still expects the
  `activity-running` skip reason; update or remove those
  expectations.

## 5. Documentation and rollout

- [x] 5.1 Update any inline JSDoc / module headers that referenced
  the old `activity-running` reason or the prior ordering
  assumptions in the runner shutdown.
- [x] 5.2 Confirm `npm run build` is clean and the full test suite
  passes locally.
- [x] 5.3 Update `docs/concepts/` or the relevant ADR sequence
  reference if any existing concept doc described the old skip
  semantics (no new ADR required; this is a behavioral fix within
  the auto-mode + worktree-management capabilities).
