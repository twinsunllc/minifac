## ADDED Requirements

### Requirement: TUI event reducer

The `run-tui` capability SHALL expose a pure event-reducer
function `runReducer(state, event) → state` that maps a
`RunState` and a single event into the next `RunState`. The
reducer SHALL accept two kinds of input events:

- **Run events**: the `NodeEventEntry` shape emitted by
  `runFactory()`'s `onEvent` callback (carrying `nodeId`,
  `iteration`, and an `event` payload of kind `stdout`,
  `stderr`, or `status`).
- **UI events**: synthetic events produced by user input —
  `navigate-up`, `navigate-down`, `enter-follow`,
  `cycle-iteration-prev`, `cycle-iteration-next`,
  `scroll-log-up`, `scroll-log-down`, `toggle-details`,
  `request-quit`, `confirm-quit`, `cancel-quit`,
  `toggle-help`, `terminate-run`.

The reducer SHALL be pure: no I/O, no `Date.now()`, no random
sources. All time-derived values (e.g. spinner frames) SHALL be
passed in as part of the event payload (e.g. a `tick` event
carrying a monotonic frame counter).

The reducer's `RunState` SHALL track at minimum:

- `brief?: { change: string }` and `factory: { name: string }`
- An ordered `nodes: NodeState[]` (declaration order)
- Each `NodeState` SHALL carry: `id`, `status` (one of
  `pending`, `running`, `succeeded`, `failed`, `retrying`),
  `iteration` (1-based; 0 when the node has never run), and
  `iterations: IterationLog[]` (one entry per `(node,
  iteration)` pair, each carrying the rendered events and the
  iteration's terminal status when known).
- `selectedNodeId: string` and `selectedIteration: number`.
- `followMode: boolean` (true ⇒ selection auto-advances with
  the running node).
- `terminalStatus?: "succeeded" | "failed"` once the run has
  reached a terminal state.

The reducer SHALL be the unit-tested surface for TUI behavior;
ink components SHALL be thin renderers over the reducer's
output.

#### Scenario: First stdout event for a node moves it to running

- **WHEN** the reducer receives a `stdout` event for node id
  `propose` whose stored status is `pending`
- **THEN** the returned state has `nodes[propose].status =
  "running"`, `iteration = 1`, and `iterations` carries one
  entry containing the rendered event

#### Scenario: status=succeeded event sets node status

- **WHEN** the reducer receives a synthetic `status` event for
  node id `propose` with payload `succeeded`
- **THEN** the returned state has `nodes[propose].status =
  "succeeded"` and the iteration's `terminalStatus` is
  `"succeeded"`

#### Scenario: status=failed followed by another stdout starts a retry

- **WHEN** node `verify` has just been marked `failed` and the
  reducer subsequently receives a `stdout` event for `verify`
- **THEN** the returned state has `nodes[verify].status =
  "running"`, `iteration = previous_iteration + 1`, and a new
  entry in `iterations`; the prior iteration's
  `terminalStatus` remains `"failed"`

#### Scenario: navigate-down pauses follow mode

- **WHEN** the reducer receives a `navigate-down` UI event from
  a state with `followMode = true` and selection at index 1
- **THEN** the returned state has `followMode = false` and
  `selectedNodeId` advanced to the next node in declaration
  order

#### Scenario: enter-follow resumes follow mode

- **WHEN** the reducer receives an `enter-follow` UI event from
  a state with `followMode = false` and a currently-running
  node
- **THEN** the returned state has `followMode = true` and
  `selectedNodeId` equal to the currently-running node's id

#### Scenario: cycle-iteration walks prior iterations

- **WHEN** the reducer receives `cycle-iteration-prev` for a
  node whose `selectedIteration` is 2 of 3
- **THEN** the returned state has `selectedIteration = 1` for
  that node; the underlying `iterations` array is unchanged

#### Scenario: terminal run-end event sets terminalStatus

- **WHEN** the reducer receives a synthetic run-end event with
  status `succeeded`
- **THEN** the returned state has `terminalStatus = "succeeded"`
  and all node statuses are unchanged from their last reported
  value

### Requirement: Stream-json log rendering rules

The TUI SHALL parse each `stdout` event payload as a stream-
json line (the same shape today's executor emits) and render
it into a `RenderedEvent` carrying:

- `kind`: one of `text`, `tool_use`, `tool_result`, `status`,
  `raw`
- `summary`: a single human-readable line suitable for the log
  pane
- `fullJson?`: the original JSON payload, present so the `d`
  (details) hotkey can expand it
- `rawNodeEvent?`: the unparsed `NodeEvent` for fallthrough

The rendering rules SHALL be:

- `system / init` events → suppressed by default (not appended
  to the log pane); still retained in the per-iteration
  `events` array so the `d` toggle can surface them.
- `rate_limit_event` events whose `status` is not `rejected`
  → suppressed by default (retained for `d`).
- `rate_limit_event` events whose `status` is `rejected`
  → rendered as a highlighted line naming the reason.
- `assistant / text` events → rendered as the text content,
  dimmed.
- `assistant / tool_use` events → rendered as one line of the
  shape `→ <ToolName>(<short args>)`, where `<short args>` is
  produced by JSON-stringifying the tool input, collapsing
  whitespace, and truncating to ~80 characters with an
  ellipsis when longer.
- `user / tool_result` events → rendered as `✓ <short result>`
  on success or `✗ <short result>` on error; the short result
  is the first non-empty line of the result content
  truncated similarly.
- `result` events → rendered as a terminal-status line for
  that iteration, naming the status and (on failure) the
  reason.
- Synthetic `status` events from the runner → rendered as a
  highlighted line with the appropriate status glyph.
- Any line that fails to parse as JSON → rendered as `kind:
  "raw"` with the line verbatim as the summary.

The `d` hotkey SHALL toggle a details mode for the currently-
highlighted log line; when enabled, the line SHALL render its
`fullJson` (pretty-printed) in place of its summary.

#### Scenario: system/init events are hidden by default

- **WHEN** a node emits a stream-json line whose `type` is
  `system` and `subtype` is `init`
- **THEN** the line is not visible in the log pane by default;
  the `d` toggle on a neighboring visible line does NOT
  surface it

#### Scenario: rate_limit_event with status=allowed is hidden

- **WHEN** a node emits a `rate_limit_event` whose `status` is
  `allowed`
- **THEN** the line is not visible in the log pane by default

#### Scenario: rate_limit_event with status=rejected is visible

- **WHEN** a node emits a `rate_limit_event` whose `status` is
  `rejected`
- **THEN** the log pane shows a highlighted line naming the
  reason

#### Scenario: tool_use renders as a one-liner

- **WHEN** a node emits an `assistant` event whose `content`
  contains a `tool_use` block for tool `Bash` with input
  `{ "command": "npm test" }`
- **THEN** the log pane shows a line of the shape `→
  Bash({"command":"npm test"})` (whitespace collapsed,
  truncated with ellipsis if longer than ~80 chars)

#### Scenario: tool_result renders ✓ or ✗

- **WHEN** a node emits a `user` event whose `content`
  contains a `tool_result` block (`is_error` falsy)
- **THEN** the log pane shows a line beginning with `✓ ` and
  the first non-empty line of the result content (truncated)

- **WHEN** the same kind of event arrives with `is_error: true`
- **THEN** the line begins with `✗ ` instead

#### Scenario: assistant text is rendered as prose

- **WHEN** a node emits an `assistant` event whose `content`
  contains a `text` block with the string `"hello world"`
- **THEN** the log pane shows a line whose summary is `hello
  world` (or the text wrapped to the pane width)

#### Scenario: d toggles full JSON for the highlighted line

- **WHEN** the `d` UI event is received while a `tool_use` log
  line is highlighted
- **THEN** the log pane renders the line as its `fullJson`
  (pretty-printed), replacing the one-liner summary; a second
  `d` returns to the summary

#### Scenario: Unparseable lines render as raw

- **WHEN** a node emits a stdout line that does NOT parse as
  JSON
- **THEN** the log pane shows the line verbatim with `kind:
  "raw"`

### Requirement: TUI layout

The TUI SHALL render the following layout when the terminal
surface is at least 80 columns by 24 rows:

- **Top header** (one row): the project name (`minifac`), the
  brief name (or `(brief-less)` for brief-less factory runs),
  the factory name, and the currently-active node name. The
  header SHALL update as execution advances.
- **Left status pane**: one row per node id in declaration
  order. Each row carries the node's status glyph, the node id,
  and (when the node has run more than once) an `(n)` suffix
  showing the current iteration.
- **Right log pane**: the rendered events for the selected
  `(node, iteration)` pair. The pane scrolls independently
  from the status pane.
- **Bottom hotkey bar** (one row): a compact hint of the
  currently-available hotkeys.

When the terminal surface is smaller than 80×24, the TUI SHALL
fall back to a single-pane layout: only the log pane is shown,
with the current node's id + status glyph prefixed as a header
line per log block. The help overlay (`?`) SHALL document this
fallback.

Status glyphs SHALL be:

| Glyph | Meaning |
|-------|---------|
| `○` (dim) | pending — not yet scheduled |
| `◔` (animated) | running — current iteration in flight |
| `●` (green) | most recent iteration succeeded |
| `●` (red) | most recent iteration failed |
| `↻` (yellow) | failed previously, retrying via on_failure |

When the runtime environment does not advertise a UTF-8 locale
(`LANG`, `LC_ALL`, and `LC_CTYPE` together contain no
`UTF-8`/`utf8` substring), the TUI SHALL substitute ASCII
glyphs (e.g. `.` for pending, `*` for running, `o` for
succeeded, `!` for failed, `*` for retrying). The Braille
spinner frames degrade to a rotating ASCII character.

#### Scenario: Top header shows brief, factory, current node

- **WHEN** the TUI is mounted for a run whose brief change is
  `foo`, whose factory is `sdd`, and whose currently-running
  node is `verify`
- **THEN** the top header includes the strings `minifac`,
  `foo`, `sdd`, and `verify`

#### Scenario: Top header on brief-less factory runs

- **WHEN** the TUI is mounted for a brief-less factory
  invocation of `hello`
- **THEN** the top header includes the string `(brief-less)`
  and the factory name `hello`

#### Scenario: Iteration count appears as (n) suffix

- **WHEN** node `verify` is on its third iteration
- **THEN** the status pane row for `verify` includes the
  suffix `(3)`

#### Scenario: Glyphs degrade to ASCII without UTF-8

- **WHEN** the TUI is mounted with environment variables
  `LANG=C`, `LC_ALL=C`, `LC_CTYPE=C`
- **THEN** the rendered status glyphs and spinner frames are
  drawn from the ASCII fallback set, not the Unicode set

#### Scenario: Sub-80x24 falls back to single-pane

- **WHEN** the TUI is mounted at a terminal size of 60×20
- **THEN** only the log pane is rendered; each log block is
  prefixed by the current node's id and status glyph; the
  status pane is not drawn

### Requirement: TUI hotkey contract

The TUI SHALL bind the following keyboard input via ink's
`useInput`. Each binding's effect is described as a UI event
fed to `runReducer` (per the "TUI event reducer"
requirement), except where the hotkey triggers an external
action.

| Key(s) | UI event / action |
|--------|-------------------|
| `↑`, `↓`, `j`, `k` | `navigate-up` / `navigate-down`; sets `followMode = false` |
| `Enter` | `enter-follow`; sets `followMode = true` and selects the currently-running node |
| `PgUp`, `PgDn` | `scroll-log-up` / `scroll-log-down` (log pane only) |
| `<`, `>` | `cycle-iteration-prev` / `cycle-iteration-next` for the selected node |
| `d` | `toggle-details` for the highlighted log line |
| `r` | Unmount the TUI and switch to raw output for the remainder of the run |
| `q` | If the run has reached a terminal status, quit immediately; otherwise display a confirmation prompt. On confirm, the TUI requests cancellation of the in-flight run (forwarding SIGTERM to the executor child), records a failure on the run row with reason `user_quit`, and exits |
| `m` | Only when `terminalStatus = "succeeded"` AND the run row's `branchName` is non-null: invoke `minifac merge <change-or-run-id>` inline, render the merge output in an overlay, and return to the TUI when the user dismisses the overlay |
| `?` | `toggle-help` overlay |

The status pane's selection SHALL auto-advance to track the
currently-running node while `followMode = true`. Any
navigation hotkey (`↑`/`↓`/`j`/`k`) SHALL flip `followMode` to
`false`; `Enter` SHALL flip it back.

The `m` hotkey SHALL NOT be advertised in the bottom hotkey
bar when the run's terminal status is not `succeeded`, or
when the run row's `branchName` is null. The hint string
SHALL include `m merge` only when both conditions hold.

#### Scenario: ↓ moves selection and pauses follow mode

- **WHEN** the TUI is rendered with `followMode = true` and the
  user presses `↓`
- **THEN** the selection in the status pane moves to the next
  node in declaration order and `followMode` is `false`

#### Scenario: Enter resumes follow mode

- **WHEN** the user has navigated away (`followMode = false`)
  and presses `Enter`
- **THEN** `followMode` becomes `true` and the selection jumps
  back to the currently-running node

#### Scenario: < and > cycle iterations

- **WHEN** node `verify` is on its second iteration and the
  user presses `<`
- **THEN** the log pane shows the events of `verify`'s first
  iteration; a subsequent `>` returns to the second

#### Scenario: d toggles details on the highlighted log line

- **WHEN** the user presses `d` while a tool_use log line is
  highlighted
- **THEN** that line's rendering switches to its pretty-
  printed full JSON; a second `d` returns to the summary

#### Scenario: r switches to raw mode for the remainder of the run

- **WHEN** the user presses `r` mid-run
- **THEN** ink unmounts, the terminal is restored, and the
  remainder of the run's events are emitted as raw line-
  prefixed events on stdout/stderr (matching `--raw` output);
  the run is not interrupted

#### Scenario: q mid-run requires confirmation

- **WHEN** the run is in flight and the user presses `q`
- **THEN** a confirmation prompt is shown (e.g. "Quit
  in-progress run? [y/N]"); the run continues until the user
  answers

#### Scenario: q confirmed mid-run records user_quit

- **WHEN** the user answers `y` to the quit prompt
- **THEN** the TUI requests cancellation of the run, the
  executor child is signalled, the run row is finalized with
  status `failed` and reason `user_quit`, the TUI unmounts,
  and the process exits non-zero

#### Scenario: q on a terminal-status run exits immediately

- **WHEN** the run has reached `succeeded` or `failed` and the
  user presses `q`
- **THEN** the TUI unmounts and the process exits with the
  matching status code (`0` for succeeded; per existing exit-
  code rules for failed)

#### Scenario: m is offered only on succeeded runs with a branch

- **WHEN** the run terminates with `succeeded` and the run row
  has a non-null `branchName`
- **THEN** the bottom hotkey bar's hint string includes `m
  merge`; pressing `m` invokes `minifac merge <change-or-run-
  id>` inline and renders the result in an overlay

- **WHEN** the run terminates with `succeeded` but the run
  row's `branchName` is null (e.g. an in-place run)
- **THEN** the bottom hotkey bar does NOT advertise `m merge`
  and pressing `m` is a no-op

- **WHEN** the run terminates with `failed`
- **THEN** the bottom hotkey bar does NOT advertise `m merge`
  and pressing `m` is a no-op

#### Scenario: ? toggles the help overlay

- **WHEN** the user presses `?`
- **THEN** the TUI renders a help overlay listing every
  available hotkey; a second `?` (or `Esc`) dismisses it

### Requirement: TUI run-completion behavior

The TUI SHALL react to a terminal run status (succeeded or
failed) by:

- Settle each node's status glyph to its final color (green for
  succeeded, red for failed, retrying glyph cleared).
- Update the top header to name the final status, and, on
  failure, the proximate reason.
- Update the bottom hotkey hint to `Run finished
  (<status>). Press q to quit[, m to merge]` (the `, m to
  merge` suffix is present only when the `m` hotkey would
  succeed per the "TUI hotkey contract" requirement).
- Stop the running-node spinner animation.
- NOT auto-exit. The TUI remains mounted until the user
  presses `q`.

The run controller's promise SHALL settle independently of TUI
unmount, so persistence (runs.db) and the final stderr summary
line happen on run completion rather than on user quit, except
in the `user_quit` mid-run path.

#### Scenario: Succeeded run shows merge hint

- **WHEN** the run terminates with `succeeded` and the run row
  has a non-null `branchName`
- **THEN** the bottom hotkey hint includes both `q quit` and
  `m merge`

#### Scenario: Failed run shows quit-only hint

- **WHEN** the run terminates with `failed`
- **THEN** the bottom hotkey hint includes `q quit` and does
  NOT include `m merge`

#### Scenario: TUI does not auto-exit on completion

- **WHEN** the run terminates and the user does not press a
  key
- **THEN** the TUI remains mounted and visible indefinitely;
  the process does not exit until the user presses `q`

#### Scenario: Spinner stops at terminal status

- **WHEN** the run terminates
- **THEN** the running-node glyph is no longer animated; every
  node's glyph reflects its final iteration's outcome
