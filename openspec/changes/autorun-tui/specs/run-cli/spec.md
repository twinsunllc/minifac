## MODIFIED Requirements

### Requirement: `minifac autorun` subcommand

The CLI SHALL expose an `autorun` subcommand that runs the autorun
poll loop (per the `auto-mode` capability's "Autorun poll loop"
requirement). The subcommand SHALL accept the following options:

- `--watch <dir>` — the inputs directory to poll. Default
  `<cwd>/inputs`. If the directory does not exist at startup, the
  CLI SHALL exit `1` with a stderr message naming the path.
- `--max-concurrent <n>` — the parallel-run cap. Default `1`.
  SHALL be a positive integer; zero or negative is a usage error.
- `--interval <ms>` — the poll cadence in milliseconds. Default
  `10000`. SHALL be a positive integer; zero or negative is a
  usage error.
- `--once` — run a single poll cycle, wait for scheduled runs to
  settle, then exit `0`. Mutually exclusive with the default
  long-running behavior (one wins; `--once` wins).
- `--filter <expr>` — restrict the candidate set to briefs whose
  `change` matches. Glob or `/<regex>/<flags?>` syntax (per the
  `auto-mode` capability's "Autorun --filter matching"
  requirement). Invalid expressions are a usage error.
- `--dry-run` — run a single poll cycle, emit decisions, exit `0`.
  Invokes no runs (per the `auto-mode` capability's "Autorun
  --dry-run mode" requirement).
- `--json` — emit log lines as one JSON object per line on stdout
  (per the `auto-mode` capability's "Autorun structured logging"
  requirement).
- `--force` — on the first SIGINT/SIGTERM, kill in-flight child
  executor processes instead of waiting for them to settle (per
  the `auto-mode` capability's "Autorun signal handling"
  requirement).
- `--raw` — force the existing raw line-prefixed / JSON output
  even when stdout is a TTY. Mutually exclusive with `--tui`;
  supplying both SHALL be a usage error.
- `--tui` — force the interactive autorun TUI (per the
  `autorun-tui` capability) even when stdout is not a TTY
  (useful for tests). Mutually exclusive with `--raw` and
  with `--json` (the JSON output stream is a machine-readable
  contract that cannot coexist with a mounted TUI).

Mode selection SHALL follow this precedence, evaluated in order
(the same precedence the `run-cli` capability's "Event output
format" requirement specifies for `minifac run`):

1. `--raw` flag → raw mode (force, even on a TTY).
2. `--tui` flag → TUI mode (force, even on a non-TTY).
3. Else, if `--json` is supplied → raw mode (the JSON stream
   wins; no TUI is mounted).
4. Else, if `process.stdout.isTTY` is truthy → TUI mode (the
   default for interactive invocations).
5. Else → raw mode (the default for pipes, redirects, and CI).

Supplying `--raw` together with `--tui` SHALL be a usage error
(exit `1`) with a stderr message naming the conflict. Supplying
`--tui` together with `--json` SHALL be a usage error
(exit `1`) with a stderr message naming the conflict.

The subcommand SHALL exit with:

- `0` when the process exits cleanly after `--once`, `--dry-run`,
  a graceful shutdown that drained all in-flight runs, or a
  TUI-driven `q` quit that drained all in-flight runs.
- `1` for usage errors (missing watch directory, bad flag value,
  invalid `--filter` expression, `--raw` + `--tui` together,
  `--tui` + `--json` together).
- `2` when a stop signal (or a second TUI-driven `q`) escalated
  to killing in-flight children (second SIGINT, first signal
  with `--force`, or `--force` with the first TUI quit).

Other exit codes from the `run-cli` capability's "Exit codes"
requirement (`2` from a node failure, `3` from budget exhaustion)
SHALL NOT propagate from individual autorun-scheduled runs to the
autorun process exit code; per-run failures are logged as
`completed status=failed` and the autorun process continues.

#### Scenario: `minifac autorun` polls inputs and schedules ready briefs

- **WHEN** the user invokes `minifac autorun` against a repo whose
  `inputs/` contains a ready brief `foo`
- **THEN** the process polls `./inputs`, schedules `foo` using the
  same run primitive `minifac run foo` would, and continues
  polling until a stop signal

#### Scenario: `minifac autorun --once` schedules ready and exits

- **WHEN** the user invokes `minifac autorun --max-concurrent 2
  --once` against a repo whose `inputs/` contains two ready briefs
- **THEN** the process schedules both briefs in parallel, waits
  for them to settle, and exits `0`

#### Scenario: `minifac autorun --dry-run` prints decisions

- **WHEN** the user invokes `minifac autorun --dry-run` against a
  repo whose `inputs/` contains one ready brief (`foo`) and one
  blocked brief (`bar`)
- **THEN** stdout contains a `dry-run-decision` event for `foo`
  (action `schedule`) and a `dry-run-decision` event for `bar`
  (action `skip`, reason `blocked`); no runs are invoked; the CLI
  exits `0`

#### Scenario: Missing watch directory is a usage error

- **WHEN** the user invokes `minifac autorun --watch
  /nonexistent/path`
- **THEN** the CLI writes a stderr message naming the path and
  exits `1`; no poll cycle runs

#### Scenario: Bad `--max-concurrent` value is a usage error

- **WHEN** the user invokes `minifac autorun --max-concurrent 0`
- **THEN** the CLI writes a stderr message naming the flag and the
  positive-integer requirement, and exits `1`

#### Scenario: Bad `--interval` value is a usage error

- **WHEN** the user invokes `minifac autorun --interval -1`
- **THEN** the CLI writes a stderr message naming the flag and the
  positive-integer requirement, and exits `1`

#### Scenario: Bad `--filter` regex is a usage error

- **WHEN** the user invokes `minifac autorun --filter
  "/[unterminated/"`
- **THEN** the CLI writes a stderr message naming the flag and the
  regex parse error, and exits `1`

#### Scenario: SIGINT drains in-flight runs and exits zero

- **WHEN** the user invokes `minifac autorun --max-concurrent 1`,
  one run is scheduled and in flight, and the user sends SIGINT
- **THEN** the CLI stops scheduling, waits for the in-flight run
  to settle, and exits `0`

#### Scenario: Second SIGINT escalates and exits non-zero

- **WHEN** the user invokes `minifac autorun`, a run is in
  flight, the user sends a first SIGINT (CLI waits), and the
  user sends a second SIGINT
- **THEN** the CLI sends SIGTERM to the in-flight child executor,
  waits briefly, and exits `2`

#### Scenario: `--force` escalates on first signal

- **WHEN** the user invokes `minifac autorun --force`, a run is
  in flight, and the user sends a SIGINT
- **THEN** the CLI immediately sends SIGTERM to the in-flight
  child executor, waits briefly, and exits `2`

#### Scenario: Per-run failure does not crash autorun

- **WHEN** the autorun process schedules `foo`, `foo`'s run
  terminates with `failed`, and another ready brief `bar` exists
- **THEN** the autorun process emits a `completed status=failed`
  event for `foo`, continues polling, and schedules `bar` on a
  later poll cycle

#### Scenario: Interactive autorun defaults to TUI

- **WHEN** the user invokes `minifac autorun` in a terminal where
  `process.stdout.isTTY` is truthy and neither `--raw`, `--tui`,
  nor `--json` is supplied
- **THEN** the CLI mounts the autorun TUI per the `autorun-tui`
  capability; the existing human-readable log lines are NOT
  written to stdout while the TUI is mounted

#### Scenario: Non-TTY autorun falls back to raw

- **WHEN** the user invokes `minifac autorun > log` (so stdout
  is not a TTY) and neither `--raw` nor `--tui` is supplied
- **THEN** the CLI emits today's human-readable log lines and
  does NOT mount the TUI

#### Scenario: --raw forces raw mode in a TTY

- **WHEN** the user invokes `minifac autorun --raw` from a TTY
- **THEN** the CLI emits the existing human-readable log lines
  and does NOT mount the TUI

#### Scenario: --tui forces TUI mode in a non-TTY

- **WHEN** the user invokes `minifac autorun --tui` with stdout
  not a TTY (e.g. piped, used by tests)
- **THEN** the CLI mounts the autorun TUI and renders into the
  non-TTY surface (snapshotted by tests via ink's testing
  utilities); the existing log lines are NOT written to stdout
  while the TUI is mounted

#### Scenario: --raw and --tui together is a usage error

- **WHEN** the user invokes `minifac autorun --raw --tui`
- **THEN** the CLI exits `1` with a stderr message naming the
  flag conflict; no poll cycle runs and no TUI is mounted

#### Scenario: --tui and --json together is a usage error

- **WHEN** the user invokes `minifac autorun --tui --json`
- **THEN** the CLI exits `1` with a stderr message naming the
  flag conflict; no poll cycle runs and no TUI is mounted

#### Scenario: --json on a TTY without --tui keeps emitting JSON

- **WHEN** the user invokes `minifac autorun --json` from a TTY
  and `--tui` is NOT supplied
- **THEN** the CLI emits one JSON object per line on stdout (the
  existing `--json` contract is preserved); no TUI is mounted
