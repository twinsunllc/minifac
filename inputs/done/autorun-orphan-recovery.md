---
change: autorun-orphan-recovery
factory: sdd
---

## Background

When an autorun child run is killed mid-flight — second `q` press,
`--force` + signal, SIGHUP, terminal close, OS kill, crash — its
`runs.db` row is left at `status='running'`. There is no startup
reaper and no inline reconciliation. On the next autorun startup
`computeBriefActivity` (`src/brief/activity.ts`) reads the most-recent
row and returns `activity: 'running'`; the scheduler then skips with
reason `activity-running` (`src/cli/autorun-scheduler.ts:154-155`).

The brief silently stays blocked until a human edits the row in
`runs.db`. The operator also has no way to tell the stuck case apart
from a legitimately-in-flight run (another autorun instance, a
manual `minifac run`, the daemon) — both surface the same skip
reason.

The recently-shipped autorun TUI (ADR 0032) made the gap more
visible because the skip reason now appears in the brief list, but
the fix lives in the scheduler / store, not the TUI.

## What to do

Use the **existing per-change lockfile** (`src/worktree/lock.ts`,
PID-bearing, with `isLivePid()` via `process.kill(pid, 0)` and the
EPERM-means-live conservative path already built in) as the
liveness oracle. No new state in `runs.db`, no new files on disk.

**Lazy reconciliation in the scheduler.** When the scheduler is
about to skip a brief with reason `activity-running`, probe the
per-change lockfile first:

- **File missing** → orphan. Mark the `runs.db` row `failed` with a
  synthetic reason `orphaned`. Then proceed to schedule normally.
- **File present, PID dead** → orphan. Same handling as above.
- **File present, PID live** (or EPERM) → really running elsewhere.
  Skip with a distinct reason `running-elsewhere` so the TUI can
  surface the difference.

**Runner ordering invariant.** Flip the runner's exit sequence so it
**writes the terminal status row to `runs.db` BEFORE releasing the
lock**. Today the ordering is not load-bearing, but the
reconciliation logic depends on "lock missing + row=running" being
unambiguous. With the write-then-release order, a graceful exit can
never leave that signature; only a kill can.

**Where the work lives.** The scheduler is the natural home for the
probe (it already imports the lockfile module via worktree creation).
Add a small helper that takes a `change` name and returns
`{ orphaned: true } | { running: true, pid: number }` for callers.

## Out of scope

- **PID-reuse paranoia.** Stashing process start times next to the
  PID to defeat the rare case where the OS reassigns a recycled PID
  to an unrelated process between crash and reap. The window is
  short, the failure mode is "skip one extra poll cycle," and it
  self-heals once that unrelated PID dies.
- **TUI surface for orphan recovery.** No "reap stale" button, no
  orphan badge in the brief-list pane. The scheduler does the work
  invisibly; the row's transition to `failed` is already visible
  through the existing render path.
- **`runs.db` schema changes.** The new reason strings (`orphaned`,
  `running-elsewhere`) should fit existing columns.
- **Startup sweep.** A one-shot reaper at autorun startup that
  walks all `status='running'` rows is a possible add, but the
  lazy path covers the same ground over a poll cycle or two with
  less code. Defer until the lazy path proves insufficient.
- **Manual `minifac runs reap` command.** Same reasoning — could
  be added later if operators ask for an on-demand version.

## Acceptance criteria

- After autorun is killed mid-flight (e.g. `kill -9` the child, or
  restart autorun after a force-quit), starting autorun again
  re-schedules the affected brief on the next poll cycle without
  manual `runs.db` intervention.
- The prior `runs.db` row for the killed run is updated to
  `status='failed'` with reason `orphaned`.
- A brief whose per-change lock is held by a live PID continues to
  be skipped, but with reason `running-elsewhere` (not
  `activity-running`).
- The runner writes the terminal status row to `runs.db` BEFORE
  releasing the lock; covered by an integration test that asserts
  the ordering.
- Scheduler unit test with a faked stale lock proves the orphan
  reconciliation path (row flipped to `failed`, scheduling
  proceeds).
- Scheduler unit test with a faked live lock proves the
  running-elsewhere path (row untouched, skip with new reason).
- All existing tests still pass; `npm run build` is clean.
