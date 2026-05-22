# auto-mode Specification

## Purpose
TBD - created by archiving change auto-mode. Update Purpose after archive.
## Requirements
### Requirement: Autorun poll loop

The autorun process SHALL operate as a poll loop that, on each
iteration, enumerates briefs from a configured watch directory,
computes each brief's state via the `brief-state` capability's
"Combined brief state and dep satisfaction" requirement, and
schedules briefs whose state is ready (as defined below) up to a
configured concurrency cap.

A brief is *ready* for autorun iff ALL of the following are true:

- The brief's `doneness` is `active` (its file resides at
  `<watch>/<change>.md`, not under `<watch>/done/`).
- Every entry in the brief's `depends_on` field resolves to
  `doneness === "done"` (i.e. its dep file lives in
  `<watch>/done/<dep>.md`).
- The brief's `activity` is `none` or `failed` (a `running` or
  `succeeded` most-recent run row excludes the brief from this
  poll's candidate set).
- The autorun process is not already running this `change` in its
  own in-flight set.
- The user-supplied `--filter` (if any) matches the `change`.

The poll loop SHALL run on a configurable cadence, default 10000ms.
The poll cadence SHALL be settable via `--interval <ms>` and SHALL
be a positive integer; zero or negative values SHALL be a usage
error.

The poll loop SHALL NOT assume any ordering from the filesystem
enumeration; it SHALL apply a stable sort by brief file `mtime`
ascending, with ties broken by `change` name lexicographically.

The poll loop SHALL continue running until a stop signal is
received (per the signal-handling requirement) or the `--once`
mode's drain completes.

#### Scenario: Default invocation polls inputs every 10 seconds

- **WHEN** the user invokes `minifac autorun` with no flags
- **THEN** the process polls `./inputs` every `10000` ms, computes
  state for each brief, schedules ready briefs up to
  `max-concurrent = 1`, and continues until a stop signal arrives

#### Scenario: Ready brief is scheduled

- **WHEN** an autorun poll observes `inputs/foo.md` with no
  `depends_on`, no in-flight run, and no recent `running` /
  `succeeded` run row
- **THEN** the autorun process invokes the run primitive for `foo`
  (same primitive used by `minifac run`) and adds `foo` to its
  in-flight set

#### Scenario: Blocked brief is not scheduled

- **WHEN** an autorun poll observes `inputs/foo.md` whose
  `depends_on` includes `bar`, and `inputs/bar.md` exists (so `bar`
  is `active`, not `done`)
- **THEN** the autorun process SHALL NOT invoke the run primitive
  for `foo`, SHALL emit a `skipped` log event with reason
  `blocked`, and SHALL re-evaluate `foo` on the next poll cycle

#### Scenario: Done brief drops out of the candidate set

- **WHEN** a previous autorun-scheduled run for `foo` completed
  with `succeeded` and the runner's mark-done step moved
  `inputs/foo.md` to `inputs/done/foo.md`
- **THEN** subsequent polls observe `foo` only in the done set;
  autorun does NOT schedule `foo` again

#### Scenario: Polling order is oldest mtime first with lex tiebreak

- **WHEN** `inputs/` contains `b.md` (mtime `t=100`), `a.md` (mtime
  `t=200`), `c.md` (mtime `t=200`), all ready, and
  `max-concurrent = 1`
- **THEN** the autorun process schedules `b` first (oldest mtime),
  then on subsequent polls when a slot frees schedules `a` before
  `c` (lex tiebreak)

### Requirement: Autorun concurrency cap

The autorun process SHALL enforce a maximum number of in-flight
runs (`--max-concurrent <n>`, default `1`). Briefs that are
otherwise ready but cannot be scheduled because the in-flight set
is at capacity SHALL be skipped with reason `concurrency` and
re-evaluated on the next poll.

The concurrency cap SHALL be a positive integer; zero or negative
values SHALL be a usage error.

Concurrent runs proceed against separate worktrees (per the
existing `worktree-management` capability). The per-change-name
lockfile (per the `worktree-management` capability's
"Per-key lockfile with PID-bearing claim" requirement) prevents
same-change collisions if a manual `minifac run` happens
externally. Cross-change concurrency is permitted up to
`max-concurrent`.

#### Scenario: `--max-concurrent 2` runs two ready briefs in parallel

- **WHEN** the user invokes `minifac autorun --max-concurrent 2`
  against an `inputs/` containing four ready, independent briefs
- **THEN** the first poll schedules exactly two of them (the two
  with oldest mtime, lex tiebreak), the other two are skipped with
  reason `concurrency`, and as in-flight runs finish later polls
  pick up the remaining ones

#### Scenario: Zero `--max-concurrent` is rejected as a usage error

- **WHEN** the user invokes `minifac autorun --max-concurrent 0`
- **THEN** the process writes a stderr message naming the
  `--max-concurrent` flag and the positive-integer requirement,
  and exits `1`

#### Scenario: Same-change collision falls back to lockfile refusal

- **WHEN** an autorun process schedules `foo` and a parallel
  `minifac run foo` invocation has already claimed the per-change
  lockfile
- **THEN** the autorun-spawned run surfaces as a `failed` start;
  the autorun process logs a `failed` event for `foo` and continues
  to schedule other ready briefs on the next poll

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
  `concurrency`, `failure-cap`, `filtered`, `in-flight`,
  `running-elsewhere`, `activity-succeeded`, `done`.
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

When the `skipped` event's `reason` is `failure-cap`, the event
SHALL carry a `detail` string of the shape `<count>/<max>` (e.g.
`3/3`) naming the current counter value and the configured cap.
The raw-mode log line SHALL include the recovery gesture
"restart autorun to retry" so operators reading tailed logs see
the action without a docs lookup. The JSON-mode object SHALL
carry the same `detail` field; the recovery gesture itself is
not a structured field (it lives in the docs and in the raw line).

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

#### Scenario: Failure-cap skip uses the new reason with count detail

- **WHEN** the autorun process skips `foo` because the per-session
  failure counter for `foo` has reached the configured cap
- **THEN** the emitted log line carries `event = "skipped"`,
  `change = "foo"`, `reason = "failure-cap"`, and a `detail`
  string of the shape `<count>/<max>` (e.g. `3/3`); the
  human-readable line additionally includes the gesture text
  "restart autorun to retry"

### Requirement: Autorun signal handling

The autorun process SHALL handle SIGINT and SIGTERM as graceful
shutdown signals. On the first signal:

1. The poll loop SHALL stop scheduling new runs.
2. The process SHALL wait for in-flight runs to settle (each
   reaches a terminal `succeeded` or `failed` status).
3. The process SHALL exit `0` after the in-flight set drains.

On a second signal (a second SIGINT, or a second SIGTERM):

1. The process SHALL escalate by sending SIGTERM to every tracked
   in-flight child executor process.
2. The process SHALL wait briefly for those children to exit, then
   itself exit with a non-zero code (`2`).

The `--force` flag SHALL change the first-signal behavior to the
escalated path: the first SIGINT/SIGTERM immediately kills
in-flight children and exits non-zero. This is the CI escape
hatch.

#### Scenario: SIGINT lets in-flight runs finish

- **WHEN** the autorun process has two in-flight runs and a SIGINT
  arrives
- **THEN** the process stops scheduling new runs, waits for the
  two in-flight runs to settle, and exits `0`; no new runs are
  scheduled even if a new ready brief appears

#### Scenario: Second SIGINT kills children

- **WHEN** the autorun process has one in-flight run, a SIGINT
  arrives (so the process is now waiting for the run to settle),
  and a second SIGINT arrives before the run finishes
- **THEN** the process sends SIGTERM to the in-flight run's child
  executor process, waits briefly, and exits with a non-zero code
  (`2`)

#### Scenario: `--force` escalates on first signal

- **WHEN** the user invokes `minifac autorun --force` and a SIGINT
  arrives while one run is in flight
- **THEN** the process immediately kills the in-flight child
  executor and exits with a non-zero code (`2`), without waiting
  for the run to settle

### Requirement: Autorun `--once` mode

The autorun process SHALL accept a `--once` flag that runs a
single poll cycle, waits for all scheduled runs to settle, and
exits `0`. The `--once` mode SHALL NOT loop; once the in-flight
set drains, the process exits.

`--once` does not bypass signal handling: a SIGINT during the
drain still escalates on the second signal per the signal-handling
requirement.

#### Scenario: `--once` schedules ready briefs and exits when they finish

- **WHEN** the user invokes `minifac autorun --max-concurrent 2
  --once` against an `inputs/` containing two ready briefs (`foo`,
  `bar`) and one blocked brief (`baz`)
- **THEN** the process schedules `foo` and `bar`, emits a
  `skipped` event for `baz` with reason `blocked`, waits for both
  scheduled runs to settle, and exits `0`

#### Scenario: `--once` exits zero with no ready briefs

- **WHEN** the user invokes `minifac autorun --once` against an
  `inputs/` containing only blocked briefs (or no briefs at all)
- **THEN** the process emits a `poll-start` event, emits one
  `skipped` event per blocked brief (if any), and exits `0` with no
  runs scheduled

### Requirement: Autorun `--dry-run` mode

The autorun process SHALL accept a `--dry-run` flag that runs a
single poll cycle, emits one `dry-run-decision` event per
candidate brief indicating whether it would be scheduled (and the
reason for skipping if applicable), and exits `0`. The `--dry-run`
mode SHALL NOT invoke the run primitive for any brief.

When `--dry-run` and `--once` are both supplied, `--dry-run` wins
(no runs are invoked).

When `--dry-run` and `--json` are combined, every
`dry-run-decision` event SHALL be emitted as a single JSON object
per line.

#### Scenario: `--dry-run` prints decisions without scheduling

- **WHEN** the user invokes `minifac autorun --dry-run` against an
  `inputs/` containing `foo` (ready), `bar` (blocked by missing
  dep), and `baz` (ready)
- **THEN** the process emits three `dry-run-decision` events —
  `foo: schedule`, `bar: skip reason=blocked`,
  `baz: schedule` — invokes no runs, and exits `0`

#### Scenario: `--dry-run --json` emits JSON decisions

- **WHEN** the user invokes `minifac autorun --dry-run --json`
- **THEN** stdout contains one JSON object per brief examined, each
  with `event === "dry-run-decision"`, a `change`, an `action`
  field (`"schedule"` or `"skip"`), and (when `action === "skip"`)
  a `reason` field

### Requirement: Autorun `--filter` matching

The autorun process SHALL accept a `--filter <expr>` flag that
restricts the candidate set by `change` name. The filter SHALL
match against the brief's `change` value (the slug), not its file
path.

Filter expressions SHALL be interpreted as:

- A string of the form `/<pattern>/<flags?>` is a regex
  (constructed as `new RegExp(pattern, flags)`). An invalid regex
  is a usage error.
- Any other non-empty string is a glob. The supported glob
  metacharacters are `*` (zero-or-more non-`/` characters) and `?`
  (exactly one non-`/` character). Other characters match
  literally. There is no `**`, no `{a,b}`, and no path semantics —
  change names are flat slugs.

When a filter is supplied, briefs whose `change` does not match
SHALL be skipped with reason `filtered`. A filter SHALL NOT
override blockedness, the activity skip rules, or the concurrency
cap.

#### Scenario: Glob filter matches a prefix

- **WHEN** the user invokes `minifac autorun --filter "feat-*"
  --once` against an `inputs/` containing `feat-foo.md`,
  `feat-bar.md`, and `chore-baz.md`
- **THEN** the process schedules `feat-foo` and `feat-bar` (subject
  to concurrency), emits a `skipped` event for `chore-baz` with
  reason `filtered`, and exits `0`

#### Scenario: Regex filter

- **WHEN** the user invokes `minifac autorun --filter "/^foo[0-9]+$/"
  --dry-run` against an `inputs/` containing `foo1.md`, `foo22.md`,
  and `bar.md`
- **THEN** the process emits `dry-run-decision` events scheduling
  `foo1` and `foo22` and skipping `bar` with reason `filtered`

#### Scenario: Invalid regex is a usage error

- **WHEN** the user invokes `minifac autorun --filter "/[unterminated/"`
- **THEN** the process exits `1` with a stderr message naming the
  `--filter` flag and the regex parse error

### Requirement: Autorun reuses the existing run primitive

The autorun process SHALL invoke the same run primitive that
`minifac run` invokes (the function that owns lockfile claim,
worktree creation, runner invocation, finalization, and journal
appending). Autorun SHALL NOT re-implement that pipeline.

This requirement is observable through behavior:

- Autorun-scheduled runs appear in [[Runs-DB]] under the same
  schema as manual runs.
- Autorun-scheduled runs claim the same per-change-name lockfile
  manual runs claim.
- Autorun-scheduled runs produce worktrees in the same location
  per the `worktree-management` capability.
- Failed autorun-scheduled runs append to the failed-run journal
  (per the `worktree-management` capability) identically to
  failed manual runs.
- The runner's mark-done post-step (per the `brief-state`
  capability) executes for autorun-scheduled runs identically to
  manual runs.

#### Scenario: Autorun-scheduled run lands in runs.db with the same shape

- **WHEN** an autorun-scheduled run for `foo` completes
- **THEN** a row exists in `runs.db` whose `change = "foo"`,
  `status ∈ {"succeeded", "failed"}`, `branch_name` populated per
  the run-scoped-branches contract, and `started_at` / `ended_at`
  filled

#### Scenario: Autorun-scheduled run produces a worktree

- **WHEN** an autorun-scheduled run for `foo` starts (not
  `--in-place`)
- **THEN** the run creates a worktree under the configured
  `worktrees_dir` and the per-change-name lockfile is claimed for
  the duration of the run

### Requirement: Autorun output mode selection

The autorun process SHALL emit scheduling events in one of two
output modes, chosen at startup:

- **Raw mode**: for each `AutorunEvent` emitted by the
  scheduler, the autorun process SHALL write a log line per
  the existing "Autorun structured logging" requirement (human-
  readable line by default; one JSON object per line when
  `--json` is supplied). This is the existing behavior; raw
  mode is unchanged.
- **TUI mode**: the autorun process SHALL drive an interactive
  terminal user interface that consumes the same
  `AutorunEvent` stream PLUS the per-run `NodeEventEntry`
  events the run primitive emits for each scheduled run, and
  renders them per the `autorun-tui` capability (brief-list
  pane, embedded run view, hotkey contract).

Mode selection SHALL follow the precedence specified by the
`run-cli` capability's "`minifac autorun` subcommand"
requirement (the same `--raw` > `--tui` > `isTTY` > raw
precedence `minifac run` uses).

In both modes, the autorun process SHALL preserve its
structured-logging contract on `--raw` / non-TTY fallback. In
TUI mode, the human / JSON log lines are NOT written to stdout
while the TUI is mounted; once the TUI unmounts (the user
presses `q`, or the user presses `r` to switch to raw mid-run),
the autorun process SHALL resume writing the existing log
format for the remainder of its lifetime, so scripts that pipe
or grep stderr / stdout after a `q` or `r` see the same shape
they see today.

The `--json` flag and the `--tui` flag SHALL be mutually
exclusive; supplying both SHALL be a usage error (per the
`run-cli` capability's "`minifac autorun` subcommand"
requirement).

The `--json` flag without `--tui` and without `--raw` on a TTY
SHALL implicitly resolve to raw mode (the JSON contract wins;
no TUI is mounted). This preserves scripts that set `--json`
and happen to run on a TTY for ad-hoc inspection.

#### Scenario: Interactive autorun defaults to TUI

- **WHEN** the user invokes `minifac autorun` from a terminal
  where `process.stdout.isTTY` is truthy and neither `--raw`
  nor `--tui` is supplied
- **THEN** the autorun process mounts the autorun TUI per the
  `autorun-tui` capability; the existing human-readable log
  lines are NOT written to stdout while the TUI is mounted

#### Scenario: Non-TTY autorun falls back to raw

- **WHEN** the user invokes `minifac autorun > log` (or any
  invocation where `process.stdout.isTTY` is not truthy) and
  neither `--raw` nor `--tui` is supplied
- **THEN** the autorun process writes today's human-readable
  log lines to stdout unchanged; no TUI is mounted

#### Scenario: --raw forces raw mode in a TTY

- **WHEN** the user invokes `minifac autorun --raw` in a
  terminal where `process.stdout.isTTY` is truthy
- **THEN** the autorun process emits the existing human-
  readable log lines and does NOT mount the TUI

#### Scenario: --tui forces TUI mode in a non-TTY

- **WHEN** the user invokes `minifac autorun --tui` with a
  stdout that is not a TTY (e.g. piped or redirected, used by
  tests)
- **THEN** the autorun process mounts the TUI and renders into
  the non-TTY surface (snapshotted by tests via ink's testing
  utilities); the existing log lines are NOT written to stdout
  while the TUI is mounted

#### Scenario: --json on a TTY without --tui resolves to raw

- **WHEN** the user invokes `minifac autorun --json` in a
  terminal where `process.stdout.isTTY` is truthy and `--tui`
  is NOT supplied
- **THEN** the autorun process emits one JSON object per line
  on stdout (the existing `--json` behavior); no TUI is
  mounted

#### Scenario: r mid-run switches to raw output for the remainder of the autorun

- **WHEN** the user presses `r` while the autorun TUI is
  mounted
- **THEN** ink unmounts, subsequent `AutorunEvent` emissions
  resume as the existing human-readable log lines (or JSON if
  `--json` was supplied), and the autorun poll loop is NOT
  interrupted

### Requirement: Autorun TUI mid-run quit semantics

The autorun process SHALL, when the TUI is mounted and the user
presses `q`, behave per its existing graceful-shutdown contract
(per the `auto-mode` capability's "Autorun signal handling"
requirement):

- The first `q` SHALL stop scheduling new runs and wait for
  in-flight runs to drain. The TUI SHALL remain mounted until
  the in-flight set drains, at which point the process exits
  `0`.
- A second `q` while draining SHALL escalate by sending SIGTERM
  to in-flight child executors and exit with a non-zero code
  (`2`), matching the second-SIGINT path.
- `--force` SHALL apply the same escalation rule to the first
  `q` that it does to the first SIGINT — the in-flight children
  are killed and the process exits `2`.

The user pressing `q` SHALL NOT bypass the per-run journal,
runs.db persistence, lockfile release, or any other
finalization the run primitive owns. Per-run failures recorded
as a result of the second-`q` escalation SHALL carry a
descriptive failure reason (e.g. `autorun_quit`), consistent
with the way `run-tui`'s `user_quit` is recorded for the
`minifac run` mid-run quit path.

#### Scenario: First q drains in-flight runs

- **WHEN** the autorun TUI is mounted, two runs are in flight,
  and the user presses `q`
- **THEN** the TUI stops scheduling, waits for the two runs to
  settle (the brief-list pane continues to update their status
  glyphs as they finish), and the process exits `0`

#### Scenario: Second q escalates

- **WHEN** the user has already pressed `q` (drain initiated),
  at least one run is still in flight, and the user presses
  `q` again
- **THEN** the autorun process signals SIGTERM to the in-flight
  child executor(s), waits briefly, unmounts the TUI, and
  exits with non-zero (`2`)

#### Scenario: --force makes the first q escalate

- **WHEN** the user invokes `minifac autorun --force`, the TUI
  is mounted, one run is in flight, and the user presses `q`
- **THEN** the autorun process immediately signals SIGTERM to
  the in-flight child executor, unmounts the TUI, and exits
  with non-zero (`2`); the run is NOT allowed to settle

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

### Requirement: Autorun per-session failure cap

The autorun process SHALL maintain a per-session, in-memory
counter of consecutive failures per `change`. After a configurable
number of consecutive failures, the autorun process SHALL skip
that `change` with a `skipped` event whose `reason` is
`failure-cap`, and SHALL continue skipping until the operator
restarts the autorun process.

The cap SHALL be controlled by a `--max-failures <n>` flag:

- The default value SHALL be `3`.
- `n` SHALL be a non-negative integer; negative, fractional, or
  non-numeric values SHALL be a usage error per the `run-cli`
  capability's "`minifac autorun` subcommand" requirement.
- A value of `0` SHALL disable the cap entirely (the legacy
  indefinite-retry behavior); the failure-cap skip event SHALL
  NOT be emitted when the cap is disabled.

The counter SHALL be incremented at the moment a dispatched run
completes when ALL of the following are true:

- The run's terminal `status` is `failed`.
- The run's terminal `reason` is NOT `user_quit` (the autorun
  process was killed; the brief itself did not fail).

An undefined or unfamiliar `reason` value SHALL count toward the
cap (the safer default: unknown reasons are treated as real
brief-side failures rather than silently exempted).

The counter SHALL NOT be incremented for:

- `user_quit` failures (operator kill of the autorun process).
- Runs that never dispatched (e.g. briefs skipped before
  `start()` for any other reason — `blocked`, `filtered`,
  `concurrency`, `in-flight`, `running-elsewhere`, `done`,
  `activity-succeeded`).
- Orphan-reconciliation row rewrites (the existing
  "Autorun reconciles orphaned runs via per-change lockfile
  probe" path flips a `running` row to `failed` with
  `reason: "orphaned"`; that row was never dispatched in this
  session and does NOT count).

The cap check SHALL run in `decide()` after the precondition
checks (`in-flight`, `filtered`, `running-elsewhere`, `done`,
`blocked`, `activity-succeeded`) and BEFORE the `concurrency`
check. A brief that would otherwise be skipped for one of the
precondition reasons SHALL surface that reason, not
`failure-cap`. A brief that has hit the cap SHALL NOT consume a
concurrency slot.

The counter SHALL be purely in-memory: a fresh autorun process
SHALL start with an empty counter map. Restart of the autorun
process is the only supported reset gesture. The CLI SHALL NOT
expose a "reset counter" command or a persistent state file in
v1.

#### Scenario: Default cap fires after three consecutive failures

- **WHEN** an autorun session dispatches `foo` three times in a
  row, each completing `status: "failed"` with a non-`user_quit`
  reason
- **THEN** the next `decide()` for `foo` SHALL return
  `action: "skip", reason: "failure-cap"`, the autorun process
  SHALL emit a `skipped` event with `change: "foo"`,
  `reason: "failure-cap"`, and `detail: "3/3"`, and SHALL NOT
  dispatch `foo` again for the remainder of the session

#### Scenario: `--max-failures 5` allows five failures before capping

- **WHEN** the user invokes `minifac autorun --max-failures 5`
  and `foo` fails five times in a row (non-`user_quit`)
- **THEN** the autorun process dispatches `foo` on all five
  failure cycles, then on the sixth poll skips `foo` with
  `reason: "failure-cap"` and `detail: "5/5"`

#### Scenario: `--max-failures 0` disables the cap

- **WHEN** the user invokes `minifac autorun --max-failures 0`
  and `foo` fails repeatedly (10+ times)
- **THEN** the autorun process keeps dispatching `foo` on every
  poll; no `skipped reason=failure-cap` event is ever emitted

#### Scenario: `user_quit` failure does not count toward the cap

- **WHEN** an autorun session dispatches `foo`, the operator
  sends SIGINT escalation that causes `foo` to terminate with
  `status: "failed", reason: "user_quit"`, and `foo` is later
  dispatched again in another autorun session (or the same one
  re-evaluates after settle)
- **THEN** the counter for `foo` is NOT incremented; the
  failure-cap behavior treats this `foo` run as if it had not
  failed

#### Scenario: Unknown failure reason counts toward the cap

- **WHEN** an autorun session dispatches `foo` and the run
  completes with `status: "failed"` and a `reason` value that is
  neither `user_quit` nor one of the recognized node-side
  reasons (or with no `reason` at all)
- **THEN** the counter for `foo` is incremented by `1`

#### Scenario: Per-change isolation

- **WHEN** an autorun session dispatches `foo` three times
  (failing each time, default cap `3`) and then evaluates `bar`
  for the first time
- **THEN** `foo` is skipped with `reason: "failure-cap"`, and
  `bar` is dispatched normally (the counter for `bar` is `0`)

#### Scenario: Restart of autorun resets the counter

- **WHEN** an autorun session has capped `foo` (counter at
  `3/3`), the operator stops autorun (SIGINT, drain, exit), and
  starts a new autorun process against the same `inputs/` tree
- **THEN** the new autorun process dispatches `foo` on the first
  poll where it is otherwise ready; the counter starts from
  `0/3`

#### Scenario: Precondition reasons take precedence over the cap

- **WHEN** an autorun session has counter `3/3` for `foo` AND
  `foo`'s `depends_on` includes an unsatisfied dep (so `foo`
  would otherwise be `skipped reason=blocked`)
- **THEN** the emitted skip event carries `reason: "blocked"`,
  NOT `reason: "failure-cap"`

#### Scenario: Cap precedes concurrency

- **WHEN** an autorun session has counter `3/3` for `foo` AND
  `--max-concurrent 1` with one in-flight run for `bar`
- **THEN** the emitted skip event for `foo` carries
  `reason: "failure-cap"` (the cap check runs before the
  concurrency check); `foo` does not contribute to the
  concurrency-skip event accounting

