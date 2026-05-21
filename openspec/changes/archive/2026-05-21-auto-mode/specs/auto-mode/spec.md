## ADDED Requirements

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
  `concurrency`, `filtered`, `in-flight`, `activity-running`,
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
