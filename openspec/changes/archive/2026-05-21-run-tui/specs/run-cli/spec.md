## MODIFIED Requirements

### Requirement: Event output format

The CLI's `run` subcommand SHALL emit node events in one of two
output modes, chosen at startup:

- **Raw mode**: for each node event received, the CLI SHALL write
  a single line to stdout (for `stdout` events) or stderr (for
  `stderr` events), prefixed with `[<node_id>] ` so multiple
  nodes' output is legible when interleaved. `status` events
  SHALL be written to stderr in a single, distinct format that
  names the node and the status.
- **TUI mode**: the CLI SHALL drive an interactive terminal user
  interface that consumes the same `onEvent` stream and renders
  it per the `run-tui` capability (layout, status pane, log pane,
  hotkey contract, log-rendering rules, completion behavior).

Mode selection SHALL follow this precedence, evaluated in order:

1. `--raw` flag → raw mode (force, even on a TTY).
2. `--tui` flag → TUI mode (force, even on a non-TTY; useful for
   tests).
3. Else, if `process.stdout.isTTY` is truthy → TUI mode (the
   default for interactive invocations).
4. Else → raw mode (the default for pipes, redirects, and CI).

`--raw` and `--tui` SHALL be mutually exclusive; supplying both
SHALL be a usage error (exit `1`) with a stderr message naming
the conflict.

In both modes, the run subcommand SHALL preserve the final
stderr summary line `[run] <status> cwd=<path>` already
documented by the `minifac run` command requirement. In TUI
mode, the summary SHALL be emitted after the TUI has unmounted
the terminal (i.e. after the user presses `q`), so scripts that
grep for `[run]` in stderr keep working when stderr is piped
even with `--tui` forced.

The auto-fallback rule (step 3 → step 4) ensures CI pipelines
and `minifac run foo > log` invocations keep producing today's
line-oriented output without any flag changes.

#### Scenario: Output lines carry node prefix

- **WHEN** node `propose` emits the stdout line "hello" and the
  subcommand is in raw mode
- **THEN** the terminal shows a line containing `[propose] hello`

#### Scenario: Status events are distinguishable from output

- **WHEN** node `propose` transitions to `succeeded` in raw mode
- **THEN** stderr receives a line that identifies both the node id
  and the status, distinct in format from `stdout`/`stderr` lines

#### Scenario: Interactive invocation defaults to TUI

- **WHEN** the user invokes `minifac run <brief>` from a terminal
  where `process.stdout.isTTY` is truthy and neither `--raw` nor
  `--tui` is supplied
- **THEN** the CLI renders the TUI per the `run-tui` capability;
  raw line-prefixed stream events are NOT written to stdout
  while the TUI is mounted

#### Scenario: Non-TTY invocation falls back to raw

- **WHEN** the user invokes `minifac run <brief> > log` (or any
  invocation where `process.stdout.isTTY` is not truthy) and
  neither `--raw` nor `--tui` is supplied
- **THEN** the CLI writes today's line-prefixed stream events to
  stdout/stderr unchanged; no TUI is mounted

#### Scenario: --raw forces raw mode in a TTY

- **WHEN** the user invokes `minifac run <brief> --raw` in a
  terminal where `process.stdout.isTTY` is truthy
- **THEN** the CLI emits raw line-prefixed events and does NOT
  mount the TUI

#### Scenario: --tui forces TUI mode in a non-TTY

- **WHEN** the user invokes `minifac run <brief> --tui` with a
  stdout that is not a TTY (e.g. piped or redirected, used by
  tests)
- **THEN** the CLI mounts the TUI and renders into the non-TTY
  surface (snapshotted by tests via ink's testing utilities);
  raw line-prefixed events are NOT written to stdout

#### Scenario: --raw and --tui together is a usage error

- **WHEN** the user invokes `minifac run <brief> --raw --tui`
- **THEN** the CLI exits `1` with a stderr message naming the
  flag conflict; no run is started

#### Scenario: Final [run] stderr summary line is preserved in both modes

- **WHEN** a run terminates in either raw mode or TUI mode (the
  latter after the user presses `q`)
- **THEN** the CLI emits the existing `[run] <status>
  cwd=<path>` line to stderr exactly once
