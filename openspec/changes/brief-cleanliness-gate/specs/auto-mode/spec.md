## ADDED Requirements

### Requirement: Autorun brief cleanliness gate

The autorun process SHALL refuse to dispatch a brief whose
`inputs/<change>.md` file (or any of its `depends_on` ancestors'
files) is in an unclean git working-tree state, as determined by
the `brief-cleanliness` capability's
`checkBriefAndAncestorsCleanliness` requirement.

The cleanliness check SHALL run inside the scheduler's `decide()`
method, after the `in-flight` and `filtered` short-circuits and
*before* `computeBriefState`. When the check returns
`{ status: "unclean", offending, code }`, the scheduler SHALL
return a skip decision with `reason: "unclean"` and a `detail`
string of:

- `"<code>"` when `offending` equals the brief being decided
  (i.e. the root brief itself is unclean), or
- `"<offending> (<code>)"` when an ancestor brief is the offender.

When the check returns `{ status: "clean" }`, scheduling
proceeds to the existing state-based dispatch path unchanged.

When the check returns `{ status: "disabled" }`, scheduling
proceeds as if the gate did not exist. The scheduler SHALL emit
exactly one warning at process startup (NOT per poll cycle) of
the form:

```
[autorun] inputs/ is not inside a git working tree; brief cleanliness gate disabled
```

When the underlying recursive walk throws `BriefCycleError`, the
scheduler SHALL treat the cycle the same way the existing
state-machine path does — surfacing the cycle as a `blocked`
skip (NOT an `unclean` skip).

The gate SHALL NOT be bypassable by any autorun flag. The
operator-side recovery gestures are: commit the brief, stash it,
or invoke `minifac run <change>` (which has its own warn-and-pause
flow per the `run-cli` capability).

#### Scenario: Untracked brief is skipped with reason unclean

- **WHEN** the autorun process polls and observes
  `inputs/foo.md` that is otherwise ready (no in-flight run, no
  filter, etc.) but has never been `git add`ed
- **THEN** the scheduler returns
  `{ action: "skip", reason: "unclean", detail: "??" }` and the
  poll loop emits a `skipped` event for `foo` with the same
  reason and detail

#### Scenario: Modified brief is skipped with reason unclean

- **WHEN** `inputs/foo.md` is tracked but its working-tree copy
  differs from the index
- **THEN** the scheduler skips `foo` with
  `reason: "unclean", detail: " M"`

#### Scenario: Unclean ancestor blocks descendant with named detail

- **WHEN** `inputs/foo.md` is committed, `foo`'s `depends_on`
  includes `bar`, and `inputs/bar.md` is untracked
- **THEN** the scheduler skips `foo` with
  `reason: "unclean", detail: "bar (??)"`

#### Scenario: Clean brief falls through to state-based dispatch

- **WHEN** `inputs/foo.md` and all of its `depends_on` ancestors
  are clean and the brief is otherwise ready
- **THEN** the scheduler does NOT short-circuit on cleanliness;
  it proceeds to `computeBriefState` and the existing scheduling
  rules

#### Scenario: Disabled gate emits one-time startup warning

- **WHEN** the autorun process starts in a working tree where
  `inputs/` is not inside any git repository
- **THEN** the autorun log contains exactly one
  `inputs/ is not inside a git working tree; brief cleanliness gate disabled`
  line at startup; subsequent polls do NOT emit the warning
  again, and dispatching proceeds as if the gate were absent

#### Scenario: in-flight precedence over unclean

- **WHEN** `inputs/foo.md` is unclean AND `foo` is already in the
  scheduler's in-flight set
- **THEN** the scheduler skips `foo` with `reason: "in-flight"`,
  NOT `reason: "unclean"` — the in-flight short-circuit runs
  first

#### Scenario: filtered precedence over unclean

- **WHEN** `inputs/foo.md` is unclean AND the autorun process was
  invoked with `--filter "bar-*"` (so `foo` does not match)
- **THEN** the scheduler skips `foo` with `reason: "filtered"`,
  NOT `reason: "unclean"`

#### Scenario: depends_on cycle is reported as blocked, not unclean

- **WHEN** the autorun scheduler decides on `foo`, `foo` depends
  on `bar`, and `bar` depends on `foo` (cycle), regardless of
  whether any brief in the cycle is clean
- **THEN** the scheduler skips `foo` with `reason: "blocked"`
  via the existing state-machine path; the cleanliness gate does
  NOT emit a separate `unclean` skip for the cycle

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
  `running-elsewhere`, `activity-succeeded`, `done`, `unclean`.
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

When the `skipped` event's `reason` is `unclean`, the event SHALL
carry a `detail` string identifying the offending file and its
porcelain status code. The shape is:

- `"<code>"` when the brief being decided is itself the offender
  (e.g. `"??"`, `" M"`, `"A "`).
- `"<offending> (<code>)"` when an ancestor named `<offending>`
  is the offender (e.g. `"bar (??)"`).

The raw-mode log lines for `unclean` SHALL include the recovery
gesture "commit or stash before autorun picks it up". For the
root-offender case:

```
[autorun] skipped <change>: brief is uncommitted (<code>); commit or stash before autorun picks it up
```

For the ancestor-offender case:

```
[autorun] skipped <change>: ancestor brief <offending> is uncommitted (<code>); commit or stash before autorun picks it up
```

The JSON-mode object SHALL carry the same `detail` field; the
recovery-gesture text is not a structured field.

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

#### Scenario: Unclean skip on root brief uses the code as detail

- **WHEN** the autorun process skips `foo` because `inputs/foo.md`
  is untracked
- **THEN** the emitted log line carries `event = "skipped"`,
  `change = "foo"`, `reason = "unclean"`, and `detail = "??"`; the
  raw-mode line includes the text
  "brief is uncommitted (??); commit or stash before autorun picks it up"

#### Scenario: Unclean skip on ancestor names the offender in detail

- **WHEN** the autorun process skips `foo` because its ancestor
  `bar` is modified-but-tracked
- **THEN** the emitted log line carries `event = "skipped"`,
  `change = "foo"`, `reason = "unclean"`, and `detail = "bar ( M)"`;
  the raw-mode line includes the text
  "ancestor brief bar is uncommitted ( M); commit or stash before autorun picks it up"
