## ADDED Requirements

### Requirement: Autorun reconciles orphaned runs via per-change lockfile probe

The autorun scheduler SHALL, before skipping a brief because its
most-recent `runs.db` row carries `status='running'`, probe the
per-change lockfile (per the `worktree-management` capability's
"Per-key lockfile with PID-bearing claim" requirement) to decide
whether the row reflects a real in-flight run or an orphan from a
prior killed process.

The probe SHALL classify the brief into exactly one of:

- **Orphan**: the lockfile is absent, OR the lockfile exists but
  its PID parses to a positive integer that the existing live-PID
  probe (the same one the lock claim uses, treating EPERM as live)
  reports as dead.
- **Running elsewhere**: the lockfile exists and its PID is live
  (or its liveness cannot be disproved — i.e. the EPERM
  conservative branch).

On the **orphan** outcome the scheduler SHALL:

1. Update the brief's most-recent `runs` row by setting
   `status='failed'`, `reason='orphaned'`, and `ended_at` to the
   current epoch milliseconds (filling `ended_at` only when the
   existing row's `ended_at` is null).
2. Proceed to evaluate scheduling for the brief on the same poll
   cycle as if the prior row had already been terminal — i.e. the
   reconciled brief is eligible to be scheduled subject to the
   usual readiness, dependency, filter, in-flight, and concurrency
   rules.

On the **running elsewhere** outcome the scheduler SHALL skip the
brief with reason `running-elsewhere` (per the modified "Autorun
structured logging" requirement below) and SHALL NOT modify the
existing `runs` row.

The probe SHALL be best-effort: a filesystem or store error during
the probe (e.g. an I/O failure reading the lockfile, an unparseable
PID, a transient `runs.db` write error during reconciliation) SHALL
fall back to the running-elsewhere skip path so the scheduler never
double-schedules a brief on uncertainty. The fallback SHALL NOT
abort the poll cycle.

#### Scenario: Missing lockfile reconciles the row and schedules the brief

- **WHEN** an autorun poll observes `inputs/foo.md` whose most-recent
  `runs` row has `status='running'`, and no lockfile exists at the
  resolved per-change lockfile path
- **THEN** the scheduler updates the `runs` row to `status='failed'`
  with `reason='orphaned'` and a populated `ended_at`, then
  schedules `foo` on the same poll cycle (subject to concurrency
  and other readiness rules)

#### Scenario: Lockfile with dead PID reconciles and schedules

- **WHEN** an autorun poll observes `inputs/foo.md` whose most-recent
  `runs` row has `status='running'`, the per-change lockfile exists,
  and the PID it names is verifiably absent (e.g. `ESRCH`)
- **THEN** the scheduler updates the `runs` row to `status='failed'`
  with `reason='orphaned'`, then schedules `foo` on the same poll
  cycle

#### Scenario: Lockfile with live PID skips with running-elsewhere

- **WHEN** an autorun poll observes `inputs/foo.md` whose most-recent
  `runs` row has `status='running'` and the per-change lockfile
  names a PID that is live (or whose liveness cannot be disproved —
  the EPERM-conservative branch)
- **THEN** the scheduler emits a `skipped` event with `change='foo'`
  and `reason='running-elsewhere'` and does NOT modify the `runs`
  row

#### Scenario: Reconciliation does not bypass other readiness rules

- **WHEN** an autorun poll observes `inputs/foo.md` whose most-recent
  `runs` row is reconciled from `running` to `failed/orphaned`, but
  `foo` has an unsatisfied `depends_on` entry
- **THEN** the scheduler does NOT schedule `foo`; it emits a
  `skipped` event with `reason='blocked'` for the same poll cycle
  (the orphan reconciliation completed regardless)

#### Scenario: Probe error degrades to running-elsewhere skip

- **WHEN** the lockfile probe raises an unexpected I/O error during
  the poll
- **THEN** the scheduler emits a `skipped` event with
  `reason='running-elsewhere'` for that brief, does NOT modify the
  `runs` row, and continues the poll cycle for other briefs

## MODIFIED Requirements

### Requirement: Autorun structured logging

The autorun process SHALL emit one log line per scheduling event.
Event kinds SHALL be exactly:

- `poll-start` — emitted at the start of every poll cycle, carrying
  the count of briefs observed.
- `started` — emitted when the autorun process invokes the run
  primitive for a brief; carries `change` and (when available)
  `runId`.
- `skipped` — emitted when a brief is not scheduled; carries
  `change` and a `reason` value drawn from the set: `blocked`,
  `concurrency`, `filtered`, `in-flight`, `running-elsewhere`,
  `activity-succeeded`, `done`.
- `completed` — emitted when an in-flight run finishes; carries
  `change`, `runId` (when available), and `status` (one of
  `succeeded`, `failed`).
- `failed` — emitted when an in-flight run terminates with
  `status: "failed"` OR when the run primitive throws before
  reaching a terminal state. Carries `change` and an error
  detail. NOTE: `completed` with `status: "failed"` MAY be emitted
  in place of a separate `failed` event when the failure is a
  normal terminal-failure; the `failed` event variant is reserved
  for primitive-level errors (e.g. lockfile collision).
- `dry-run-decision` — emitted only in `--dry-run` mode (per the
  `--dry-run` requirement below); replaces `started` and `skipped`
  for that one cycle.

The reason value `activity-running` is RESERVED and SHALL NOT be
emitted by the scheduler. The `running-elsewhere` reason replaces
it: when the most-recent `runs` row for a brief is `status='running'`
the scheduler probes per the "Autorun reconciles orphaned runs via
per-change lockfile probe" requirement and either reconciles the
row (no skip event for the running-activity reason) or emits
`skipped` with `reason='running-elsewhere'`.

Every event SHALL include an ISO-8601 timestamp.

The default output format SHALL be a single human-readable line per
event. The `--json` flag SHALL cause each event to be emitted as a
single-line JSON object on stdout, with all event fields
serialized as-is plus an explicit `event` field set to the event
kind. Output SHALL be line-buffered (one event per line, flushed
before the next event is processed) so pipelines can consume it in
real time.

#### Scenario: Default scheduling event is a human-readable line

- **WHEN** the autorun process schedules `foo`
- **THEN** stdout contains a single line of the shape
  `<iso-timestamp> started foo[ runId=<id>]`

#### Scenario: `--json` mode emits one JSON object per event

- **WHEN** the user invokes `minifac autorun --json --once` and
  one brief is scheduled and then completes `succeeded`
- **THEN** stdout contains at least three JSON objects, one per
  line: an object with `event === "poll-start"`, an object with
  `event === "started"`, and an object with `event === "completed"`
  and `status === "succeeded"`; each object includes an ISO `ts`
  field and the `change`

#### Scenario: Skipped event carries the reason

- **WHEN** the autorun process skips `foo` because `foo` has an
  unsatisfied dep
- **THEN** the emitted log line (human-readable or JSON) carries
  `event = "skipped"`, `change = "foo"`, and `reason = "blocked"`;
  the JSON variant additionally carries a `detail` string naming
  the unsatisfied dep(s)

#### Scenario: Running-elsewhere skip uses the new reason

- **WHEN** the autorun process probes the lockfile for `foo`, finds
  a live PID, and skips
- **THEN** the emitted log line carries `event = "skipped"`,
  `change = "foo"`, and `reason = "running-elsewhere"`; the legacy
  reason `activity-running` is NOT emitted for this case
