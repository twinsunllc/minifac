## ADDED Requirements

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
