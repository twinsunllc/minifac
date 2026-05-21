## ADDED Requirements

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

The subcommand SHALL exit with:

- `0` when the process exits cleanly after `--once`, `--dry-run`,
  or a graceful shutdown that drained all in-flight runs.
- `1` for usage errors (missing watch directory, bad flag value,
  invalid `--filter` expression).
- `2` when a stop signal escalated to killing in-flight children
  (second SIGINT, or first signal with `--force`).

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
