## ADDED Requirements

### Requirement: Runner finalizes runs.db status before releasing the per-change lockfile

The run primitive SHALL, on every run termination path (success,
failure, and any exception that still reaches the run's
`try/finally` shutdown), complete the `RunStore.finalizeRun` write
that transitions the `runs` row from `status='running'` to a
terminal status (`succeeded` or `failed`) BEFORE it `unlink`s the
per-change lockfile (per the "Per-key lockfile with PID-bearing
claim" requirement).

The ordering invariant SHALL hold even when finalization fails: a
`finalizeRun` rejection SHALL be surfaced (logged, propagated to
the run-result) but SHALL NOT short-circuit the lockfile release.
The release SHALL still run last so the per-change lock does not
leak.

The runner MAY perform other shutdown work (event flushing,
worktree leave) in any order relative to these two operations,
provided the `runs.db` row write completes before the lockfile
`unlink` is issued.

The invariant is observable: at any moment between process start
and a fully-clean graceful exit, the combination "no lockfile at
`<locks_dir>/<key>.lock`" AND "`runs.status='running'` for the
matching `runs.id`" SHALL NOT occur. The only path to that
combination is a kill that terminates the runner between
`finalizeRun` and the next operation.

This invariant exists so the autorun scheduler's orphan probe (per
the `auto-mode` capability's "Autorun reconciles orphaned runs via
per-change lockfile probe" requirement) can treat
"lockfile-missing + row=running" as an unambiguous orphan
signature.

#### Scenario: Graceful success writes terminal status before unlocking

- **WHEN** a run reaches a terminal node that succeeds and the
  runner enters its shutdown sequence
- **THEN** the `runs` row for the run reaches `status='succeeded'`
  in `runs.db` before the lockfile at
  `<locks_dir>/<key>.lock` is unlinked; an observer that polls the
  two atomically never sees the row as `running` while the lockfile
  is already absent

#### Scenario: Graceful failure writes terminal status before unlocking

- **WHEN** a run terminates with `status='failed'` (any reason)
  through the normal shutdown sequence
- **THEN** the `runs` row is updated to `status='failed'` before
  the lockfile is unlinked

#### Scenario: finalizeRun error does not block lockfile release

- **WHEN** `RunStore.finalizeRun` rejects with an I/O error during
  shutdown
- **THEN** the runner surfaces the error (e.g. logs it, propagates
  to the run-result) AND still proceeds to unlink the lockfile so
  the lock does not leak; the row may remain `status='running'`
  and is recoverable by the autorun orphan-probe path on the next
  poll
