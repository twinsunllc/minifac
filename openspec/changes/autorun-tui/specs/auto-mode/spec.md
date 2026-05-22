## ADDED Requirements

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
