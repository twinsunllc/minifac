## Context

Decision [`0021-Run-TUI`](../../../docs/decisions/0021-Run-TUI.md)
pins the *what*. This document pins the *how* against the current
codebase.

Current state (relevant excerpts):

- `src/cli.ts` exposes `runCli(argv, io)` with an `io` shape that
  carries `stdout`, `stderr`, and optionally `stdin` (each
  optionally TTY-flagged). The `run` action wires an `onEvent`
  callback into `runFactory()` that writes `[<nodeId>] <line>` to
  stdout for `stdout` events, the same shape on stderr for
  `stderr` events, and `[status] <node> iter=<n>: <status>` to
  stderr for synthetic status events.
- `runFactory()` already accepts a single `onEvent` consumer and
  composes naturally with persistence (runs.db already subscribes
  via the same callback path).
- A succeeded run records a `branchName` on the run row; the
  archived `run-scoped-branches` change introduced `minifac merge`
  which resolves a run by change or run-id prefix and merges its
  branch into the caller's default branch.
- `src/cli.ts` writes a single final stderr summary line
  `[run] <status> cwd=<path>` after every run terminates. This
  line is preserved in both raw and TUI modes — the TUI writes it
  to stderr after ink has unmounted on quit, so scripts that grep
  for `[run]` keep working when piping stderr.

Constraints from `CLAUDE.md`:

- TypeScript strict mode. New files use kebab-case.
- The graph is directed with cycles allowed; renderings MUST NOT
  assume acyclicity (the reducer collapses to one row per node id
  with an iteration count).
- "Minimize new deps" — but the TUI is a real new surface and
  hand-rolling it would bury us. The decision is to accept `ink`
  as one new runtime dep.
- Tests live next to the code.

## Goals / Non-Goals

**Goals:**

- `minifac run <brief>` in a TTY shows the TUI by default; pipes
  / CI keep working unchanged.
- `--raw` and `--tui` flags override mode detection.
- One row per node id in the status pane; the iteration count is
  a `(n)` suffix and `<` / `>` cycles iterations for cycling
  factories.
- Selection follows the running node by default; user navigation
  pauses follow mode; `Enter` resumes it.
- Log presentation is parsed and rendered per event type; `d`
  toggles the raw JSON for the highlighted event.
- `r` switches the remainder of the run to raw output; the user
  doesn't have to restart.
- `q` quits; mid-run quits prompt for confirmation and, on
  confirm, kill the child and record a user-quit failure on the
  run row.
- `m` (only when terminal-status is succeeded AND the run has a
  non-null `branchName`) invokes `minifac merge` inline.
- Snapshot tests cover key render states; reducer unit tests
  cover each event-type transition.
- All existing 357+ tests still pass.

**Non-Goals:**

- No TUI for daemon-mode (`minifac serve`) runs — the web viewer
  is that surface.
- No mid-run intervention (pausing a node, sending a message)
  before [[0017-Callback-Status-Signaling]] lands.
- No remote / shared TUI state.
- No theming beyond the UTF-8 / ASCII glyph fallback.

## Decisions

### Decision: `ink` is the rendering library

[ink](https://github.com/vadimdemedes/ink) — React for CLI.
TypeScript-native, mature, used in production by major CLIs
(Gemini, Copilot CLI, others). One runtime dep added (`ink` +
React as its peer); `ink-testing-library` for tests is dev-only.

**Why not blessed:** lower-level API, less momentum, harder for
contributors.

**Why not hand-rolled ANSI:** TUIs are tedious from scratch and
the maintenance burden exceeds the dep tax.

### Decision: A pure reducer is the seam between events and ink

All TUI state transitions are expressed by `runReducer(state,
event) → state` in `src/tui/reducer.ts`. The reducer takes:

- a `NodeEventEntry` from `runFactory()`'s `onEvent` callback
  (the same shape today's stdout formatter consumes), or
- a synthetic UI event (`navigate`, `toggle-follow`,
  `cycle-iteration`, `toggle-details`, `request-quit`,
  `quit-confirmed`, etc.)

…and returns a new `RunState`. The reducer is the unit-tested
surface; ink components are thin renderers over it.

**Why a single reducer:** keeps the TUI's behavior testable
without spinning up ink. Lets the future studio surface (HTTP /
SSE) reuse the same shape against the same events.

### Decision: One row per node id, not per (node, iteration)

The left pane shows declaration-order node ids. The status glyph
reflects the most recent iteration's outcome; an `(n)` suffix
counts iterations when `n > 1`. The `<` / `>` keys cycle through
prior iterations of the selected node.

**Why:** cycling factories (verify → apply recovery loops) would
otherwise overflow the status pane.

### Decision: Mode detection at startup, not per render

The output mode is chosen once in `src/cli.ts` before the run
starts:

1. `--raw` flag → raw mode (force)
2. `--tui` flag → TUI mode (force, even on non-TTY)
3. else `process.stdout.isTTY` truthy → TUI mode
4. else raw mode

Raw mode wires today's `onEvent` formatter unchanged. TUI mode
constructs an `InkRunRenderer` that exposes the same
`(entry: NodeEventEntry) => void` callback shape, internally
calling `runReducer` and re-rendering ink. The `r` hotkey
("raw for the rest of the run") unmounts ink and swaps the
callback to the raw formatter at the next event.

**Why both flags:** the decision asks for parity in both
directions, and `--tui` is useful for snapshot tests against a
synthetic non-TTY stdout.

### Decision: Event rendering — parse, summarize, optionally expand

Each `stdout` event from the runner is itself a stream-json line
from the executor. The TUI parses each line and produces a
`RenderedEvent`:

| Event type | Default render | Details (`d`) render |
|------------|---------------|----------------------|
| `system / init` | suppressed | full JSON |
| `rate_limit_event` (status != rejected) | suppressed | full JSON |
| `rate_limit_event` (status == rejected) | highlighted line with reason | full JSON |
| `assistant / text` | prose, dim | full JSON |
| `assistant / tool_use` | `→ <ToolName>(<short args>)` | full JSON |
| `user / tool_result` | `✓ <short>` or `✗ <short>` | full JSON |
| `result` | terminal status line | full JSON |
| synthetic `status` | highlighted line with glyph | n/a |
| unparseable | raw text | n/a |

The "short args" for tool_use truncate to a single line by
collapsing whitespace and capping at ~80 chars. The summary is
deterministic so snapshot tests are stable.

**Why the suppression list:** the user's felt friction is signal
buried in chatter. System init is constant per node; rate-limit
allowed events fire frequently and convey nothing actionable.

### Decision: Hotkey contract

| Key | Behavior |
|-----|----------|
| `↑` / `↓` / `j` / `k` | Move selection in status pane; `followMode = false` |
| `Enter` | `followMode = true`; jump to currently-running node |
| `PgUp` / `PgDn` | Scroll log pane |
| `<` / `>` | Previous / next iteration of selected node |
| `d` | Toggle full-JSON details for highlighted log line |
| `r` | Switch to raw output for the rest of the run |
| `q` | Quit. Mid-run: prompts for confirmation; on confirm, kills child and records a `user_quit` failure on the run row |
| `m` | (Only when run is `succeeded` AND `branchName != null`) invoke `minifac merge <change-or-id>` inline; result rendered in a popup overlay |
| `?` | Toggle help overlay |

### Decision: Minimum terminal size

Render targets ≥ 80×24. Below that, the TUI falls back to a
single-pane mode (log pane only, with the current node's status
inline as a prefix on each event). The help overlay (`?`)
documents this.

**Why:** 80×24 is the historical baseline for terminal layouts.
Smaller surfaces would force unreadable truncation in the two-
pane layout.

### Decision: Glyphs degrade to ASCII

Unicode glyphs (`○ ◔ ● ↻ ⠋ → ✓ ✗`) are used by default. When
`process.env.LANG`, `LC_ALL`, or `LC_CTYPE` doesn't contain
`UTF-8`/`utf8`, the TUI substitutes ASCII (`. * o ! * > + - ! *`)
chosen for visual contrast. `src/tui/glyphs.ts` exports the
mapping; tests cover the fallback by stubbing the env.

### Decision: `m` (merge) invocation

`m` is offered only when:

1. The run's terminal status is `succeeded`, AND
2. The persisted run row has a non-null `branchName`.

On press, the TUI invokes the existing `minifac merge` action
in-process by re-entering the CLI router with
`["merge", "<change>"]` (or `["merge", "<run-id>"]` for brief-less
runs). The merge writes to a captured stdout/stderr buffer that
the TUI renders inside a small overlay; the user presses any key
to dismiss and return to the TUI.

**Why re-enter via the router:** keeps merge logic in one
place. The TUI doesn't fork a subprocess for an action the
parent CLI already owns.

### Decision: Quit-mid-run records `user_quit`

When the user confirms `q` while a run is in flight, the TUI:

1. Calls a `requestQuit()` hook on the run controller that
   forwards SIGTERM to the executor child process and rejects
   the run promise with `{ status: "failed", reason: "user_quit" }`.
2. Allows the existing `try/finally` in `src/cli.ts` to journal
   the failure and emit the `[run] failed cwd=<path>` summary.

The TUI itself does not write to runs.db directly; it relies on
the existing persistence path so the failure mode is the same
as any other terminated run.

**Why a dedicated reason string:** so a future `runs` listing can
distinguish user-aborted runs from executor failures without
parsing the proximate node id.

## Risks / Trade-offs

- [Risk] Adding React to a small CLI grows install size by a few
  hundred KB. → Mitigation: locked in `package.json`; the
  alternative (hand-rolled ANSI) was rejected for maintenance.
- [Risk] Snapshot tests over ink output are sensitive to layout
  width. → Mitigation: tests pin a fixed columns/rows via ink's
  testing util; the reducer is the primary unit-tested surface.
- [Risk] The `r` (raw) hotkey unmounts mid-run; if ink leaks the
  TTY state we'd corrupt the terminal. → Mitigation: ink's
  `unmount()` restores the terminal; tested explicitly.
- [Risk] Quit-mid-run depends on the runner cooperating with
  child-process cancellation. → Mitigation: the runner already
  exposes a cancellation token via the executor surface; the
  TUI plumbs to it rather than fighting the runner.
- [Risk] Minimum terminal size of 80×24 means tiny tmux panes
  may render the fallback. → Mitigation: documented in the help
  overlay; raw mode is one keystroke away.

## Migration Plan

This is additive — no migrations or breaking changes to the
runner or storage.

- Land the change behind no flag; the new default takes effect
  on the next release.
- Document `--raw` for CI/scripts in README + examples so users
  hitting unexpected TUI in pipelines know the escape.
- The single final stderr summary line (`[run] <status>
  cwd=<path>`) is preserved verbatim in both modes; existing
  scripts that grep stderr keep working.

## Open Questions

- Exact color palette beyond Unicode/ASCII fallback (depends on
  what ink + chalk make easy).
- Whether `?` (help) is a separate ink "mode" or a popup overlay.
  Deferred — both work; design pins overlay for v1.
- Whether the `m` (merge) overlay grows a confirmation prompt
  for non-ff merges. Deferred to a follow-up if the inline
  invocation surprises users.
