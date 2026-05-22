# autorun-tui Specification

## Purpose
TBD - created by archiving change autorun-tui. Update Purpose after archive.
## Requirements
### Requirement: Brief-list event reducer

The `autorun-tui` capability SHALL expose a pure event-reducer
function `autorunReducer(state, event) → state` that maps a
`BriefListState` and a single event into the next
`BriefListState`. The reducer SHALL accept two kinds of input
events:

- **Autorun events**: the `AutorunEvent` shape produced by the
  autorun process (per the `auto-mode` capability's "Autorun
  structured logging" requirement) — `poll-start`, `started`,
  `skipped`, `completed`, `failed`, `dry-run-decision`,
  `startup`, `info`.
- **UI events**: synthetic events produced by user input —
  `select-brief-next`, `select-brief-prev`, `enter-brief`,
  `back-to-list`, `request-quit`, `confirm-quit`, `cancel-quit`,
  `toggle-help`.

The reducer SHALL be pure: no I/O, no `Date.now()`, no random
sources. All time-derived values (e.g. spinner frames) SHALL be
passed in as part of the event payload.

The reducer's `BriefListState` SHALL track at minimum:

- An ordered `briefs: BriefRowState[]` (insertion order: first
  appearance in a `poll-start` event's observed set wins).
- Each `BriefRowState` SHALL carry: `change` (the brief's
  change slug), `status` (one of `queued`, `running`,
  `succeeded`, `failed`, `skipped`), optional `runId` once a
  `started` event has been observed, optional `skipReason` when
  `status === "skipped"`, and an optional embedded per-run
  state slot (the `RunState` shape from the `run-tui`
  capability) populated for any brief whose run has produced
  events.
- `selectedBriefIndex: number` — index into `briefs`.
- `focus: "brief-list" | "run-view"` — when `"brief-list"`,
  keyboard input drives brief selection; when `"run-view"`, the
  selected brief is drilled into and keyboard input is routed
  to the embedded run-mode reducer per the `run-tui` capability.
- `quitConfirm: boolean` — true when the user has requested
  quit but in-flight runs are still being drained.

The reducer SHALL be the unit-tested surface for autorun TUI
behavior; ink components SHALL be thin renderers over the
reducer's output.

#### Scenario: poll-start event records observed briefs

- **WHEN** the reducer receives a `poll-start` event from a
  startup state with no briefs and the autorun process
  subsequently feeds individual `started` / `skipped` events
  for each observed brief
- **THEN** the returned state's `briefs` array contains one
  `BriefRowState` per observed brief, in the order the
  individual events arrived (the `poll-start` event carries
  only a count, not the brief names, per the `auto-mode`
  capability's structured-logging requirement)

#### Scenario: started event moves the brief to running

- **WHEN** the reducer receives a `started` event for change
  `foo` whose stored status is `queued` (or absent)
- **THEN** the returned state has the `foo` row with
  `status = "running"` and `runId` populated from the event

#### Scenario: completed status=succeeded sets the brief succeeded

- **WHEN** the reducer receives a `completed` event for change
  `foo` with `status: "succeeded"`
- **THEN** the returned state has the `foo` row with
  `status = "succeeded"`

#### Scenario: completed status=failed sets the brief failed

- **WHEN** the reducer receives a `completed` event for change
  `foo` with `status: "failed"`
- **THEN** the returned state has the `foo` row with
  `status = "failed"`

#### Scenario: skipped event sets the brief skipped with reason

- **WHEN** the reducer receives a `skipped` event for change
  `foo` with `reason: "blocked"`
- **THEN** the returned state has the `foo` row with
  `status = "skipped"` and `skipReason = "blocked"`

#### Scenario: skipped brief can transition back to queued or running on a later poll

- **WHEN** the reducer first receives a `skipped` event for
  change `foo` (so its status is `skipped`) and subsequently
  receives a `started` event for the same change
- **THEN** the returned state has the `foo` row with
  `status = "running"`; the `skipReason` is cleared

#### Scenario: dry-run-decision routes to queued or skipped

- **WHEN** the reducer receives a `dry-run-decision` event for
  change `foo` with `action: "schedule"`
- **THEN** the returned state has the `foo` row with
  `status = "queued"`

- **WHEN** the reducer receives a `dry-run-decision` event for
  change `bar` with `action: "skip"` and `reason: "blocked"`
- **THEN** the returned state has the `bar` row with
  `status = "skipped"` and `skipReason = "blocked"`

#### Scenario: select-brief-next moves selection

- **WHEN** the reducer receives a `select-brief-next` UI event
  from a state with `selectedBriefIndex = 0` and at least two
  briefs
- **THEN** the returned state has `selectedBriefIndex = 1`;
  `focus` remains `"brief-list"`

#### Scenario: select-brief-prev clamps at the top

- **WHEN** the reducer receives a `select-brief-prev` UI event
  from a state with `selectedBriefIndex = 0`
- **THEN** the returned state's `selectedBriefIndex` is still
  `0` (no wrap-around)

#### Scenario: enter-brief drills into the embedded run view

- **WHEN** the reducer receives an `enter-brief` UI event from
  a state with `focus = "brief-list"` and the selected brief
  has a non-null embedded `RunState` slot
- **THEN** the returned state has `focus = "run-view"`; the
  brief-list selection is unchanged

#### Scenario: back-to-list returns focus to the brief list

- **WHEN** the reducer receives a `back-to-list` UI event from
  a state with `focus = "run-view"`
- **THEN** the returned state has `focus = "brief-list"`; the
  embedded `RunState` slot is preserved (not cleared) so that
  re-entering shows the same run state

#### Scenario: enter-brief is a no-op when no run events have arrived

- **WHEN** the reducer receives an `enter-brief` UI event for a
  brief whose embedded `RunState` slot is null (no run events
  yet — e.g. the brief is `queued` or `skipped`)
- **THEN** the returned state has `focus = "brief-list"`
  (unchanged); a `request-quit` UI event is the only way to
  leave the brief-list

### Requirement: Brief status glyphs

The `autorun-tui` capability SHALL render each brief row's status
as a single glyph in the brief-list pane. The glyphs SHALL be
drawn from the same Unicode/ASCII glyph table the `run-tui`
capability uses (per its "TUI layout" requirement) so that the
visual vocabulary is consistent across run-mode and autorun-mode.

| Glyph | Meaning |
|-------|---------|
| `○` (dim) | queued — observed but not running |
| `◔` (animated) | running — autorun has scheduled and not yet completed |
| `●` (green) | succeeded — most recent terminal status was succeeded |
| `●` (red) | failed — most recent terminal status was failed |
| `↷` (dim) | skipped — most recent autorun decision was skip |

When the runtime environment does not advertise a UTF-8 locale
(per the `run-tui` capability's "TUI layout" requirement), the
TUI SHALL substitute ASCII glyphs (`.` for queued, `*` for
running, `o` for succeeded, `!` for failed, `~` for skipped).

#### Scenario: Queued brief renders with the dim queued glyph

- **WHEN** a brief's `status` in the reducer state is `queued`
- **THEN** the brief-list pane's row for that brief shows the
  queued glyph (`○` in Unicode, `.` in ASCII fallback)

#### Scenario: Running brief renders with the animated running glyph

- **WHEN** a brief's `status` is `running`
- **THEN** the brief-list pane's row for that brief shows the
  animated running glyph (the same Braille spinner used in
  run-mode, or the ASCII fallback)

#### Scenario: Succeeded brief renders with green ●

- **WHEN** a brief's `status` is `succeeded`
- **THEN** the brief-list pane's row shows a green `●` (or
  `o` in ASCII fallback)

#### Scenario: Failed brief renders with red ●

- **WHEN** a brief's `status` is `failed`
- **THEN** the brief-list pane's row shows a red `●` (or
  `!` in ASCII fallback)

#### Scenario: Skipped brief renders with the skipped glyph

- **WHEN** a brief's `status` is `skipped`
- **THEN** the brief-list pane's row shows the skipped glyph
  (`↷` in Unicode, `~` in ASCII fallback)

### Requirement: Autorun TUI layout

The autorun TUI SHALL render into the same bounded outer Box,
the same three vertically stacked bordered zones (header, body,
hotkey bar), and the same `MIN_TUI_ROWS` clamp the `run-tui`
capability specifies (per its "TUI layout" requirement). The
autorun TUI SHALL NOT re-specify those outer-Box rules; it
inherits them by reusing the run-mode outer Box and zone
components.

The autorun TUI's zone contents SHALL be:

- **Header zone** (top): a single content row carrying the
  string `minifac autorun`, the watch directory's basename, and
  the in-flight counter (`in-flight=<n>/<max-concurrent>`). When
  `focus = "run-view"`, the header SHALL additionally include
  the embedded run-mode header content (brief change, factory
  name, current node — per the `run-tui` capability's "TUI
  layout" requirement) so the operator can see both contexts
  without leaving the drilled-in view.
- **Body zone** (middle): the **brief-list pane** on the left
  (fixed-ish width 24 columns, one row per brief with status
  glyph + change name + an optional small suffix for the most
  recent run's status), and the **embedded run view** on the
  right (the existing `<StatusPane>` + log pane from the
  `run-tui` capability). The two are separated by a vertical
  rule spanning the full body height. When no brief has been
  selected yet (the empty state at startup), the right pane
  SHALL render a one-line hint
  ("Press ↑/↓ to select a brief, Enter to drill in") instead
  of an empty run view. When the terminal surface is smaller
  than the 80×24 threshold defined in the `run-tui` capability,
  the body SHALL collapse to a single pane: only the
  brief-list when `focus = "brief-list"`, only the embedded
  log pane when `focus = "run-view"`.
- **Hotkey bar zone** (bottom): the hotkey hints described in
  the "Autorun TUI hotkey contract" requirement below, varying
  by focus.

The brief-list pane retains the fixed-ish 24-column width; the
remaining body width is given to the embedded run view (which
internally splits status pane + log pane per the `run-tui`
capability's layout).

#### Scenario: Header shows watch dir and in-flight counter

- **WHEN** the TUI is mounted with `--watch ./inputs
  --max-concurrent 2` and two runs are in flight
- **THEN** the header zone contains `minifac autorun`, the
  basename `inputs`, and the string `in-flight=2/2`

#### Scenario: Empty state shows a hint instead of an empty run view

- **WHEN** the TUI is mounted and no brief has been observed yet
  (no `poll-start` event has produced rows)
- **THEN** the body zone renders the brief-list pane on the
  left (empty) and a one-line hint on the right
  ("Press ↑/↓ to select a brief, Enter to drill in")

#### Scenario: Drilled-in view renders the embedded run view on the right

- **WHEN** the TUI is mounted with at least one brief whose
  embedded `RunState` slot is populated, `focus = "run-view"`,
  and that brief is the selection
- **THEN** the body zone's right pane renders the existing
  run-mode `<StatusPane>` + log pane against the embedded
  `RunState`; the brief-list pane on the left still shows all
  briefs with their status glyphs

#### Scenario: Sub-80×24 collapses to a single pane

- **WHEN** the TUI is mounted at a terminal size of 60×20 and
  `focus = "brief-list"`
- **THEN** the body zone shows only the brief-list pane; no
  embedded run view, no vertical rule

- **WHEN** the same TUI receives an `enter-brief` UI event
  (so `focus` becomes `"run-view"`)
- **THEN** the body zone shows only the embedded log pane;
  the brief-list is hidden until `back-to-list` flips focus

### Requirement: Autorun TUI hotkey contract

The autorun TUI SHALL bind the following keyboard input via
ink's `useInput`. Behavior varies by `focus`. The brief-list
hotkeys SHALL be:

| Key(s) | UI event (focus = brief-list) |
|--------|-------------------------------|
| `↑`, `k` | `select-brief-prev` |
| `↓`, `j` | `select-brief-next` |
| `Enter` | `enter-brief` (no-op when the selected brief has no `RunState` slot) |
| `r` | Unmount the TUI and switch to raw output for the remainder of the autorun process |
| `q` | If no runs are in flight, quit immediately; otherwise display a confirmation prompt. On confirm, the TUI initiates the autorun graceful-shutdown path (per the `auto-mode` capability's "Autorun signal handling" requirement): stop scheduling, drain in-flight runs, exit `0`. On the second `q` while draining, the TUI escalates by signalling in-flight children and exits non-zero (matching the second-SIGINT path) |
| `?` | `toggle-help` overlay |

When `focus = "run-view"`, the autorun TUI SHALL delegate every
keypress to the `run-tui` capability's hotkey contract EXCEPT:

- `Esc` SHALL produce the autorun-specific `back-to-list` UI
  event (returning focus to the brief-list pane); the run-mode
  TUI does NOT bind `Esc`, so this delegation does not conflict.
- `r` and `q` retain the autorun-level meaning above (raw
  switch, quit). The embedded run-mode TUI's `r` / `q` bindings
  are NOT routed when the autorun TUI is the host — the autorun
  TUI is the process owner; the embedded view is a child of
  its ink tree, and quit is a process-level action.

The brief-list selection SHALL NOT auto-advance to track which
brief is currently running. Selection is operator-driven only.

#### Scenario: ↓ moves brief-list selection

- **WHEN** the TUI is rendered with `focus = "brief-list"`,
  two briefs in the state, `selectedBriefIndex = 0`, and the
  user presses `↓`
- **THEN** the selection moves to index 1; focus remains on
  the brief-list

#### Scenario: Enter on a runnable brief drills in

- **WHEN** the user presses `Enter` while a brief with a
  populated `RunState` slot is selected
- **THEN** `focus` becomes `"run-view"`; the embedded
  run-mode view renders that brief's `RunState` on the right
  pane and the hotkey bar advertises the run-mode hotkeys

#### Scenario: Enter on a queued or skipped brief is a no-op

- **WHEN** the user presses `Enter` while a brief whose
  `RunState` slot is null (queued, skipped, never started) is
  selected
- **THEN** `focus` remains `"brief-list"`; the embedded run
  view continues to render the empty-state hint

#### Scenario: Esc from the drilled-in view returns to the brief list

- **WHEN** the user presses `Esc` while `focus = "run-view"`
- **THEN** `focus` becomes `"brief-list"`; the embedded
  `RunState` slot is preserved so re-entering re-renders it

#### Scenario: r switches to raw output for the remainder of the autorun

- **WHEN** the user presses `r` (from either focus state)
- **THEN** ink unmounts, the terminal is restored, and
  subsequent autorun events are emitted as the existing
  human-readable log lines on stdout (matching `--raw`
  output); the autorun process is NOT interrupted

#### Scenario: q with no in-flight runs quits immediately

- **WHEN** the user presses `q` while no runs are in flight
- **THEN** ink unmounts, the autorun process exits `0`, and
  the existing final stderr summary lines are emitted after
  unmount

#### Scenario: q with in-flight runs initiates graceful drain

- **WHEN** the user presses `q` while at least one run is in
  flight
- **THEN** the TUI invokes the autorun graceful-shutdown path:
  scheduling stops, the brief-list status glyphs continue to
  update as in-flight runs settle, the hotkey bar advertises
  the second-`q` escalation, and the process exits `0` when
  the in-flight set drains

#### Scenario: Second q while draining escalates

- **WHEN** the user has pressed `q` (drain initiated), at
  least one run is still in flight, and the user presses `q`
  a second time
- **THEN** the TUI signals SIGTERM to in-flight child
  executors (per the autorun second-signal path), waits
  briefly, unmounts, and exits with a non-zero code (`2`)

#### Scenario: ? toggles a help overlay

- **WHEN** the user presses `?`
- **THEN** the TUI renders a help overlay listing every
  available hotkey (brief-list and drilled-in variants); a
  second `?` (or `Esc`) dismisses it

### Requirement: Embedded run-mode view reuses run-tui

The autorun TUI's drilled-in view SHALL reuse the `run-tui`
capability's existing event reducer (`runReducer`), components
(status pane, log pane, hotkey bar contents), event-rendering
rules (per the `run-tui` capability's "Stream-json log
rendering rules" requirement), and glyph table (per the
`run-tui` capability's "TUI layout" requirement). The autorun
TUI SHALL NOT re-implement any of those concerns.

The autorun TUI SHALL feed `NodeEventEntry` events into the
selected brief's embedded `RunState` slot via `runReducer`,
exactly as `minifac run`'s TUI does. The per-brief
`RunState` slot is rehydrated on each `enter-brief` (already
populated from prior events) and continues to be updated by
incoming `NodeEventEntry` events whether or not the brief is
currently the selection — so switching to a brief after its run
finished shows the final state, not an empty pane.

#### Scenario: Stream-json rendering matches run-mode exactly

- **WHEN** the autorun TUI is drilled into a brief whose
  embedded run emits an `assistant / tool_use` event for tool
  `Bash` with input `{ "command": "npm test" }`
- **THEN** the embedded log pane shows the same one-liner
  `→ Bash({"command":"npm test"})` shape that
  `minifac run` would render for the same event (per the
  `run-tui` capability's stream-json rendering rules)

#### Scenario: Background brief updates continue while another brief is drilled in

- **WHEN** the autorun TUI is drilled into brief `foo` and
  brief `bar` (not currently selected) receives a
  `NodeEventEntry` for one of its nodes
- **THEN** `bar`'s embedded `RunState` slot in the
  brief-list state is updated; the `bar` row's status glyph
  in the brief-list pane reflects the new state on the next
  re-render; switching back to `bar` shows the updated run
  view, not an empty one

### Requirement: TUI does not change the autorun primitive

The autorun TUI SHALL NOT change the autorun process's poll
loop (per the `auto-mode` capability's "Autorun poll loop"
requirement), concurrency cap (per "Autorun concurrency cap"),
signal handling (per "Autorun signal handling"), the run
primitive invocation (per "Autorun reuses the existing run
primitive"), or persistence to `runs.db`. The TUI SHALL be a
new consumer of the existing `AutorunEvent` callbacks and an
additional consumer of the per-run `NodeEventEntry` stream the
run primitive already emits.

The autorun process's behavior in non-TUI modes (`--raw`,
`--json`, non-TTY fallback to raw) SHALL be unchanged from the
`auto-mode` capability's existing structured-logging
requirement.

#### Scenario: Autorun TUI does not crash on a per-run failure

- **WHEN** the autorun TUI is mounted, a scheduled run for
  brief `foo` terminates with `failed`, and another ready
  brief `bar` exists
- **THEN** the brief-list updates `foo`'s row to the `failed`
  status, the poll loop schedules `bar` on a subsequent cycle
  (matching the headless behavior), and the TUI continues to
  render without unmounting

#### Scenario: Persistence is unchanged in TUI mode

- **WHEN** the autorun TUI is mounted and a scheduled run for
  brief `foo` completes
- **THEN** the `runs.db` row for `foo`'s run carries the same
  fields it would carry under raw / JSON output (factory,
  change, status, started_at, ended_at, branch_name); no TUI-
  specific column is added or modified

