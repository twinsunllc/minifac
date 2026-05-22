## Context

The autorun loop (`src/cli/autorun-scheduler.ts`) consults
`computeBriefActivity` (`src/brief/activity.ts`), which inspects the
most-recent `runs.db` row for each brief's `change`. When that row is
`status='running'` the scheduler skips with reason `activity-running`
and re-evaluates on the next poll. This is correct when the row
really reflects an in-flight run, and wrong when the run was killed
without ever writing a terminal status (force quit, SIGKILL, crash,
terminal close).

The per-change lockfile in `src/worktree/lock.ts` already encodes
liveness with the right semantics: an exclusive-create write of the
owning PID at lock claim, a best-effort `unlink` in `try/finally` at
release, and an `isLivePid` probe that treats `EPERM` as "still
live" (the conservative branch). This change reuses that lockfile
as the truth source for orphan detection — no new state, no new
files.

## Goals / Non-Goals

**Goals:**

- Eliminate the "stuck `status='running'` row blocks autorun
  forever" failure mode without operator intervention.
- Distinguish orphaned runs from legitimately-concurrent runs in
  the autorun event stream (and therefore in the TUI's brief-list
  pane).
- Make the orphan-detection signature unambiguous by ordering the
  runner's exit so a graceful exit never leaves the orphan-looking
  combination.

**Non-Goals:**

- PID-reuse paranoia (start-time stashing). The failure window is
  short, the failure mode is one extra poll skip, and the system
  self-heals once the reused PID exits.
- Eager startup sweep that reaps every `status='running'` row at
  autorun launch. The lazy path covers the same ground over a poll
  cycle or two with less code.
- TUI affordances for orphan recovery (no "reap stale" button, no
  orphan badge). The transition to `failed` is already visible
  through the existing render path.
- `runs.db` schema change. The new reason strings (`orphaned`,
  `running-elsewhere`) fit the existing `runs.reason` TEXT column.
- A manual `minifac runs reap` command. Deferred until the lazy
  path proves insufficient.

## Decisions

### Decision: Use the per-change lockfile as the liveness oracle

**Choice:** Probe `<locks_dir>/<repo-hash>-<change>-<factory>.lock`
in the scheduler. Missing file or dead PID = orphan; live PID (or
EPERM-means-live) = running elsewhere.

**Alternatives considered:**

- *Stash a separate liveness file under `~/.minifac/heartbeats/`.*
  Introduces new state to keep coherent with `runs.db` and the
  lockfile. Two truth sources, three failure modes.
- *Add a `heartbeat_at` column to `runs` and write it periodically
  from the runner.* Forces a schema change and a writer-cadence
  decision. The existing lockfile already encodes liveness for
  free.
- *Trust `runs.db` exclusively and add a "stale after N minutes"
  timeout.* Picks an arbitrary threshold that is wrong for short
  runs (too eager) and long runs (too patient). The lockfile gives
  a precise answer with no timer.

**Rationale:** The lockfile already exists, is already PID-bearing,
already has the EPERM-conservative liveness probe, and is already
claim/release-bracketed around the same run boundary we care about.
Reusing it costs one extra `stat`+`readFile` per skipped brief per
poll cycle. The brief lives in scope where the scheduler already
constructs lockfile paths via worktree creation, so the import graph
does not grow.

### Decision: Runner writes terminal status BEFORE releasing the lock

**Choice:** Reorder the runner's exit sequence so `finalizeRun(...)`
on the run store resolves before the lockfile `unlink` runs.

**Alternatives considered:**

- *Leave ordering as-is and probe `runs.db` for staleness directly.*
  Without the ordering invariant, "lock missing + row=running"
  could occur briefly during a normal graceful exit (between the
  unlink and the finalize). The probe would race the exit. The
  ordering invariant closes the race.
- *Encode a state machine that distinguishes "exited gracefully but
  still writing" from "killed mid-write".* Overbuilt; a single
  ordering invariant gets the same guarantee for free.

**Rationale:** Today the order is incidental. Making it load-bearing
costs nothing — both operations live in the same `try/finally`
shutdown sequence — and turns the orphan probe into a clean boolean
question.

### Decision: Replace `activity-running` with `running-elsewhere`

**Choice:** After this change, the scheduler never emits skip reason
`activity-running`. The only legitimate "row says running" outcome
is either (a) reconcile + schedule, or (b) skip with reason
`running-elsewhere`. Drop `activity-running` from the event enum.

**Alternatives considered:**

- *Keep `activity-running` in the enum for forward compatibility.*
  Nothing emits it after the change, so it would be dead vocabulary
  that downstream consumers (the TUI, log greppers) would have to
  remember to ignore. Cleaner to drop.
- *Keep `activity-running` and add `running-elsewhere` alongside
  it, emitting whichever applies.* Same dead-vocabulary problem
  plus inconsistency about which to emit.

**Rationale:** `activity-running` was a proxy for "the row says
running, we don't know more than that." The probe turns that into
real information, so the proxy retires.

### Decision: Reconcile lazily in the scheduler, not eagerly at startup

**Choice:** The scheduler probes a brief only when it is otherwise
about to skip that brief for the running-activity reason. No startup
sweep, no background reaper.

**Alternatives considered:**

- *One-shot reaper at autorun startup that walks every
  `status='running'` row and reconciles orphans in one pass.*
  Faster recovery (single poll cycle vs. up to N poll cycles for N
  affected briefs), but more code and a new place for partial
  failure. The lazy path catches every affected brief within one
  poll cycle per brief, which is fine for the failure rate this
  recovers from (rare; manual force-quit, terminal close).

**Rationale:** Match the smallest change that produces the desired
behavior. If operators report that lazy recovery is too slow in
practice, the eager sweep is a follow-up change.

### Decision: Helper shape is `{ orphaned: true } | { running: true, pid: number }`

**Choice:** Expose a small helper (probable location: extend
`src/worktree/lock.ts` or add a sibling module) that takes the
lockfile key inputs and returns the discriminated union above.

**Rationale:** The two callers we care about (the scheduler today,
a possible future `minifac runs reap` command) both want the same
question answered the same way. The discriminated union forces
callers to handle both branches at compile time. PID is surfaced for
log lines / error messages in the live case; it is omitted in the
orphan case because there is nothing useful to report.

## Risks / Trade-offs

- **PID reuse window:** The OS may reassign a recycled PID between
  the runner's death and the scheduler's probe. Outcome:
  `running-elsewhere` skip for one extra poll cycle, then self-heal
  when the unrelated PID dies. Mitigation: accept; document; revisit
  if it bites.
- **Daemon / external `minifac run` interactions:** If the daemon
  or a manual `minifac run` legitimately holds the lock, we skip
  with `running-elsewhere`, which is correct. The autorun process
  does not race the daemon for the lockfile; only the actual runner
  process claims it.
- **Lock module surface growth:** The new helper widens
  `src/worktree/lock.ts`'s public surface from "claim/release" to
  "claim/release/probe." Acceptable — probe is a natural sibling of
  claim and shares the EPERM-conservative liveness function.
- **Finalize-before-unlock and shutdown signals:** If the runner
  itself receives a fatal signal between `finalizeRun` and
  `unlink`, we leave a held lockfile with a dead PID and a
  finalized `runs.db` row. The probe will surface the dead PID,
  classify as orphan, and the next claim will reclaim the stale
  lock per the existing `worktree-management` "Stale lock from a
  dead PID is reclaimed" requirement. Net effect: no observable
  change. Mitigation: none needed.
- **Test flakes from PID-based fixtures:** Scheduler unit tests
  must inject the liveness probe (rather than depending on real
  PIDs). Mitigation: pass the probe in as a function argument or
  dependency.

## Migration Plan

No data migration. Existing `runs` rows with `status='running'` and
no live lockfile become eligible for orphan reconciliation on the
next autorun poll after the change ships. Operators who restart
autorun after upgrade will see those rows transition to
`status='failed'` with `reason='orphaned'` automatically.

## Open Questions

- *Should the orphan reconciliation also surface a one-off event
  on the autorun event stream (e.g. `reconciled`) so operators
  watching `--json` can correlate the row transition?* Defer; the
  brief explicitly leaves TUI surfacing out of scope, and the
  `runs.db` row transition is observable through the existing
  render. Revisit if logs prove confusing.
- *Should the lazy probe extend to non-autorun call sites (e.g.
  the daemon's activity calculation)?* The brief scopes the
  change to the scheduler. Out of scope for this proposal; can be
  generalized later if the daemon grows a similar need.
