## MODIFIED Requirements

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
  recent run's status), separated from the right region by a
  vertical rule spanning the full body height. The **right
  region** SHALL render the embedded run view using the SAME
  body composition the `run-tui` capability's `RunApp` uses
  (per its "TUI layout" requirement): a fixed-width 24-column
  status / nodes pane on the inside-left, a vertical rule, and
  the log pane filling the remaining width. The overall body
  therefore reads as three visible columns when drilled in:
  brief-list (24) | nodes pane (24) | log pane (flex). When no
  brief has been selected yet (the empty state at startup), the
  right region SHALL render a one-line hint
  ("Press ↑/↓ to select a brief, Enter to drill in") instead of
  an empty run view. When the terminal surface is smaller than
  the 80×24 threshold defined in the `run-tui` capability, the
  body SHALL collapse to a single pane: only the brief-list when
  `focus = "brief-list"`, only the embedded log pane when
  `focus = "run-view"`.
- **Hotkey bar zone** (bottom): the hotkey hints described in
  the "Autorun TUI hotkey contract" requirement below, varying
  by focus.

The brief-list pane retains the fixed-ish 24-column width; the
remaining body width is given to the embedded run view (which
internally splits a 24-column status pane + log pane per the
`run-tui` capability's layout). The autorun TUI SHALL NOT stack
the status pane on top of the log pane; the embedded body MUST
be side-by-side, matching `RunApp`'s body shape verbatim.

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

#### Scenario: Drilled-in view renders the embedded run view as three columns

- **WHEN** the TUI is mounted with at least one brief whose
  embedded `RunState` slot is populated, `focus = "run-view"`,
  and that brief is the selection
- **THEN** the body zone renders three visible vertical
  regions: the brief-list pane (24 cols, leftmost) showing all
  briefs with their status glyphs, the embedded run-mode status
  / nodes pane (24 cols, middle) listing the run's nodes with
  their status glyphs, and the embedded log pane (flex width,
  rightmost) showing the run's events; vertical rules separate
  the three regions

#### Scenario: Drilled-in body matches RunApp's body shape

- **WHEN** the same drilled-in frame is compared against the
  body shape `RunApp` renders for the same `RunState` at the
  same terminal size
- **THEN** the autorun TUI's right region (the embedded run
  view) is laid out side-by-side (status / nodes pane width 24,
  vertical rule, log pane flexGrow), NOT stacked vertically;
  the visual output for that region is the same as `RunApp`
  would produce in standalone run mode

#### Scenario: Sub-80×24 collapses to a single pane

- **WHEN** the TUI is mounted at a terminal size of 60×20 and
  `focus = "brief-list"`
- **THEN** the body zone shows only the brief-list pane; no
  embedded run view, no vertical rule

- **WHEN** the same TUI receives an `enter-brief` UI event
  (so `focus` becomes `"run-view"`)
- **THEN** the body zone shows only the embedded log pane;
  the brief-list is hidden until `back-to-list` flips focus

### Requirement: Embedded run-mode view reuses run-tui

The autorun TUI's drilled-in view SHALL reuse the `run-tui`
capability's existing event reducer (`runReducer`), components
(status pane, log pane, hotkey bar contents), event-rendering
rules (per the `run-tui` capability's "Stream-json log
rendering rules" requirement), glyph table (per the `run-tui`
capability's "TUI layout" requirement), AND body layout (per
the `run-tui` capability's "TUI layout" requirement: 24-column
status pane + vertical rule + log pane flexGrow). The autorun
TUI SHALL NOT re-implement or restyle any of those concerns;
the embedded view's body composition SHALL be visually
indistinguishable from what `RunApp` renders for the same
`RunState` at the same width.

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

#### Scenario: Embedded body shape matches run-mode exactly

- **WHEN** the autorun TUI is drilled into a brief at a
  normal terminal size (e.g. 100×30) and the embedded
  `RunState` contains at least one node with at least one
  emitted event
- **THEN** the right region's body composition (status / nodes
  pane on the left, vertical rule, log pane on the right) is
  visually identical to the body `RunApp` would render for the
  same `RunState` at the same width — same pane widths, same
  rule placement, same content

#### Scenario: Background brief updates continue while another brief is drilled in

- **WHEN** the autorun TUI is drilled into brief `foo` and
  brief `bar` (not currently selected) receives a
  `NodeEventEntry` for one of its nodes
- **THEN** `bar`'s embedded `RunState` slot in the
  brief-list state is updated; the `bar` row's status glyph
  in the brief-list pane reflects the new state on the next
  re-render; switching back to `bar` shows the updated run
  view, not an empty one

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

The reducer SHALL clear `skipReason` on any non-skip transition
out of `skipped`: when a `BriefRowState` whose status is
`skipped` receives a subsequent `started`, `completed`, or
`dry-run-decision: schedule` event for the same change, the
resulting row's `skipReason` SHALL be `undefined`. The reducer
SHALL NOT carry the `skipReason` forward to a non-skipped row;
the displayed suffix for a non-skipped row SHALL NOT include the
old reason.

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

#### Scenario: full skipped to started to completed sequence clears skip reason

- **WHEN** the reducer receives, in order, a `skipped` event
  for change `foo` (reason: `activity-succeeded`), then a
  `started` event for change `foo`, then a `completed` event
  for change `foo` with `status: "succeeded"`
- **THEN** the final state has the `foo` row with
  `status = "succeeded"`, `skipReason === undefined`, and
  `runId` populated from the `started` event (or the
  `completed` event if the `started` event omitted it); no
  residual skip-reason data survives in any field of the row

- **WHEN** the same sequence ends with `completed` carrying
  `status: "failed"` instead of `succeeded`
- **THEN** the final state has the `foo` row with
  `status = "failed"` and `skipReason === undefined`

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
