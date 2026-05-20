## ADDED Requirements

### Requirement: `minifac runs` subcommand

The CLI SHALL expose a `runs` subcommand that lists persisted
runs from the `run-storage` capability's store. The subcommand
SHALL accept the following options:

- `--factory <name>` — filter runs by factory name (matched
  against the run's stored `factoryName`).
- `--change <name>` — filter runs by brief change (matched
  against the run's stored `change`).
- `--status <s>` — filter runs by status, where `s` is one of
  `running`, `succeeded`, or `failed`. Any other value SHALL
  be a usage error.
- `--limit <n>` — cap the number of runs returned. SHALL be a
  positive integer; default `20`.
- `--json` — emit the run list as a JSON array on stdout
  (suitable for piping). The JSON SHALL be one array of
  objects, each carrying at minimum `id`, `factoryName`,
  `change`, `status`, `startedAt`, and `endedAt`.

Default output (no `--json`) SHALL be a compact human-readable
table with at least the columns id (short prefix is acceptable
when the prefix is unambiguous), change (or factory when the
run is brief-less), status, started-at (local time), and
duration (when terminal). Runs SHALL be sorted by `startedAt`
descending so the most recent runs are first.

The subcommand SHALL NOT mutate the store. The subcommand SHALL
NOT invoke any external service. The subcommand SHALL exit `0`
on success (including when zero runs match) and `1` on a usage
error (bad flag, unparseable value) or a fatal storage error
(e.g. cannot open the database).

#### Scenario: `runs` with no flags lists recent runs

- **WHEN** the store contains 50 runs and the user invokes
  `minifac runs`
- **THEN** the CLI prints a table with at most 20 rows (the 20
  most recent by `startedAt`), each row identifying the run's
  id-prefix, change (or factory), status, started-at, and
  duration; the CLI exits `0`

#### Scenario: `--factory` filters by factory

- **WHEN** the user invokes `minifac runs --factory sdd`
- **THEN** every row in the output corresponds to a run whose
  stored `factoryName` is `sdd`; other factories are omitted

#### Scenario: `--status` rejects bad values

- **WHEN** the user invokes `minifac runs --status wat`
- **THEN** the CLI exits `1` with a stderr message naming the
  allowed values (`running`, `succeeded`, `failed`)

#### Scenario: `--json` emits an array

- **WHEN** the user invokes `minifac runs --limit 3 --json`
- **THEN** stdout contains exactly one JSON array of at most 3
  objects (each with at minimum `id`, `factoryName`, `change`,
  `status`, `startedAt`, `endedAt`); the CLI exits `0`

#### Scenario: `--limit` rejects non-positive values

- **WHEN** the user invokes `minifac runs --limit 0` (or `-5`,
  or `abc`)
- **THEN** the CLI exits `1` with a stderr message naming the
  flag and the requirement (positive integer)

#### Scenario: No matches still exits `0`

- **WHEN** the user invokes `minifac runs --change nonexistent`
  and no run has that change
- **THEN** the CLI prints an empty table (or `[]` with `--json`)
  and exits `0`

### Requirement: `minifac runs show <id>` subcommand

The CLI SHALL expose a `runs show <id>` subcommand that prints
the event log for a single persisted run. The positional `<id>`
SHALL accept either a full run id or any unambiguous prefix.

The subcommand SHALL accept:

- `--follow` — after printing the buffered events, keep tailing
  the run's events until the run terminates. v0 MAY implement
  tailing via short-interval polling of the store (e.g. every
  250 ms). When `--follow` is supplied for a run whose stored
  status is already terminal, the subcommand SHALL print the
  buffered events and exit `0` without polling.
- `--json` — emit events as JSON, one event object per line
  (newline-delimited JSON), for piping. When combined with
  `--follow`, the subcommand SHALL keep emitting JSON lines
  until the run terminates.

Default output (no `--json`) SHALL prefix each event line with
`[<nodeId>]` for `stdout` and `stderr` events (matching the
existing per-event output of `minifac run`). `status` events
SHALL be rendered in the same distinct format `minifac run`
uses. The synthetic `run_end` event SHALL be rendered as a
final summary line naming the terminal status and reason.

The subcommand SHALL exit:

- `0` on success (event log printed, or `--follow` tail
  completed).
- `1` on a usage error (e.g. unparseable id) or fatal storage
  error.
- `1` on an unknown id (one that doesn't match any run id or
  unambiguous prefix), with a stderr message naming the input.
- `1` on an ambiguous prefix that matches multiple runs, with a
  stderr message naming the matching ids.

#### Scenario: `runs show <id>` prints the event log

- **WHEN** the user invokes `minifac runs show ab12cd34` against
  a store with a run id starting with that prefix
- **THEN** the CLI prints every persisted event for that run in
  `seq` order, each `stdout` / `stderr` event prefixed with its
  node id, then a final summary line for the run's terminal
  status; the CLI exits `0`

#### Scenario: Ambiguous prefix is a usage error

- **WHEN** the user invokes `minifac runs show ab` and two run
  ids share that prefix
- **THEN** the CLI exits `1` with a stderr message naming both
  matching ids; no events are printed

#### Scenario: Unknown id is a usage error

- **WHEN** the user invokes `minifac runs show deadbeef` and no
  run id matches (full or prefix)
- **THEN** the CLI exits `1` with a stderr message naming the
  input

#### Scenario: `--follow` tails an active run

- **WHEN** the user invokes `minifac runs show <id> --follow`
  against a run whose stored status is `running`
- **THEN** the CLI prints buffered events, then continues
  printing newly persisted events as they arrive, then prints
  the terminal-status summary line and exits `0` once the run
  is finalized

#### Scenario: `--follow` on a terminal run does not poll forever

- **WHEN** the user invokes `minifac runs show <id> --follow`
  against a run whose stored status is `succeeded` or `failed`
- **THEN** the CLI prints the buffered events, prints the
  terminal-status summary, and exits `0` promptly without
  entering a polling loop

#### Scenario: `--json` emits NDJSON

- **WHEN** the user invokes `minifac runs show <id> --json`
- **THEN** stdout contains one JSON object per line, one per
  persisted event in `seq` order, with no surrounding array or
  trailing comma; the CLI exits `0`
