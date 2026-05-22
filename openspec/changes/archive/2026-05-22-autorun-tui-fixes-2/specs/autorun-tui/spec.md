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
  brief-list (24) | nodes pane (24) | log pane (flex), with
  TWO vertical-rule glyphs in the body row separating the
  three regions. When no brief has been selected yet (the
  empty state at startup), the right region SHALL render a
  one-line hint ("Press ↑/↓ to select a brief, Enter to drill
  in") instead of an empty run view. When the terminal surface
  is smaller than the 80×24 threshold defined in the `run-tui`
  capability, the body SHALL collapse to a single pane: only
  the brief-list when `focus = "brief-list"`, only the embedded
  log pane when `focus = "run-view"`.
- **Hotkey bar zone** (bottom): the hotkey hints described in
  the "Autorun TUI hotkey contract" requirement below, varying
  by focus.

The brief-list pane retains the fixed-ish 24-column width; the
remaining body width is given to the embedded run view (which
internally splits a 24-column status pane + log pane per the
`run-tui` capability's layout). The autorun TUI SHALL NOT stack
the status pane on top of the log pane; the embedded body MUST
be side-by-side, matching `RunApp`'s body shape verbatim.

The body row in the drilled-in view SHALL contain exactly two
vertical-rule glyphs — one between the brief-list pane and the
nodes pane, and one between the nodes pane and the log pane.
This invariant SHALL be asserted by an automated test that
inspects the rendered frame independently of any committed
snapshot, so that a snapshot regenerated from a buggy frame
cannot pass review.

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

#### Scenario: Drilled-in body contains exactly two vertical rules

- **WHEN** the TUI is mounted at a terminal size of 100×30 with
  `focus = "run-view"` and the selected brief has a populated
  `RunState` slot
- **THEN** the rendered body row contains exactly two
  vertical-rule glyphs (the Unicode `│` from ink's `borderStyle:
  "single"`, or the ASCII fallback equivalent under non-UTF-8
  locales) — one between the brief-list pane and the nodes
  pane, one between the nodes pane and the log pane. An
  automated test SHALL assert this count independently of any
  committed snapshot

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

The autorun TUI SHALL animate the per-node spinner glyph in
the embedded run view while any node is in a running-ish
status (`running` or `retrying`). The animation SHALL be
driven by dispatching `runReducer({ kind: "tick" })` into the
selected brief's `runState` slot from the autorun TUI's
existing spinner tick loop — the same tick semantics
`minifac run`'s TUI uses, sharing one clock for the process.
The autorun TUI SHALL NOT invent a parallel spinner clock for
the embedded view, and SHALL NOT mount any of the run-mode
TUI's own tick effects (those belong to `RunApp` and are not
reachable when the embedded view is composed via the shared
`RunBody` component).

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

#### Scenario: Embedded per-node spinner animates while a node runs

- **WHEN** the autorun TUI is drilled into a brief whose
  embedded `RunState` has a node in status `running` (or
  `retrying`), and the autorun TUI's tick loop fires
- **THEN** that node's spinner glyph in the embedded status
  pane advances frame-by-frame, matching the animation
  `minifac run`'s TUI produces for the same `RunState` at the
  same tick cadence. The advance SHALL be produced by
  dispatching `runReducer({ kind: "tick" })` into the brief's
  `runState` slot; no other tick-emitter SHALL be required

#### Scenario: Embedded spinner stops when no node is running

- **WHEN** the autorun TUI is drilled into a brief whose
  embedded `RunState` has no node in a running-ish status (all
  nodes pending, succeeded, or failed)
- **THEN** the autorun TUI's tick loop SHALL NOT dispatch
  `runReducer({ kind: "tick" })` into that brief's `runState`
  slot (the embedded glyph stays static), avoiding a
  per-frame `setState` while idle

### Requirement: Brief status glyphs

The `autorun-tui` capability SHALL render each brief row's status
as a single glyph in the brief-list pane. For the four statuses
that have a direct analog in the `run-tui` capability's node
status table (queued/pending, running, succeeded, failed), the
brief-list pane SHALL render the SAME glyph and the SAME color
the `run-tui` capability's status pane renders for the
corresponding node status (per its "TUI layout" requirement),
so that the visual vocabulary is identical between the two
panes. The `skipped` brief status has no node analog and keeps
its own brief-specific glyph and color.

The mapping SHALL be:

| Brief status | Glyph / color | Source of truth |
|--------------|---------------|-----------------|
| `queued` | open circle (`○` Unicode / `.` ASCII), gray | run-tui status pane `pending` row |
| `running` | shared `<Spinner>` braille frames (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` Unicode / `\|/-\` ASCII), yellow | run-tui status pane `running` row |
| `succeeded` | filled circle (`●` Unicode / `o` ASCII), green | run-tui status pane `succeeded` row |
| `failed` | filled circle (`●` Unicode / `!` ASCII), red | run-tui status pane `failed` row |
| `skipped` | `↷` Unicode / `~` ASCII, gray | brief-specific (no node analog) |

When the runtime environment does not advertise a UTF-8 locale
(per the `run-tui` capability's "TUI layout" requirement), the
TUI SHALL substitute ASCII glyphs per the table above. The
ASCII fallback policy SHALL be inherited from the `run-tui`
capability's glyph table for the four shared states; the
brief-specific `skipped` fallback (`~`) is the only autorun-
owned ASCII glyph.

The brief-list pane SHALL apply the status color to BOTH the
glyph cell and the brief change-name cell on the row (matching
the run-tui status pane's behavior of coloring both the glyph
and the node id). A drift between glyph color and label color
on either side SHALL be considered a regression.

#### Scenario: Queued brief renders with the dim queued glyph

- **WHEN** a brief's `status` in the reducer state is `queued`
- **THEN** the brief-list pane's row for that brief shows the
  queued glyph (`○` in Unicode, `.` in ASCII fallback), gray —
  the same glyph and color the run-tui status pane uses for a
  `pending` node row

#### Scenario: Running brief renders with the animated running glyph

- **WHEN** a brief's `status` is `running`
- **THEN** the brief-list pane's row for that brief shows the
  shared `<Spinner>` running through the same braille frames
  (or the ASCII fallback) the run-tui status pane animates for
  a `running` node row, yellow

#### Scenario: Succeeded brief renders with green ●

- **WHEN** a brief's `status` is `succeeded`
- **THEN** the brief-list pane's row shows a green `●` (or
  `o` in ASCII fallback) — the same glyph and color the
  run-tui status pane uses for a `succeeded` node row

#### Scenario: Failed brief renders with red ●

- **WHEN** a brief's `status` is `failed`
- **THEN** the brief-list pane's row shows a red `●` (or
  `!` in ASCII fallback) — the same glyph and color the
  run-tui status pane uses for a `failed` node row

#### Scenario: Skipped brief renders with the skipped glyph

- **WHEN** a brief's `status` is `skipped`
- **THEN** the brief-list pane's row shows the skipped glyph
  (`↷` in Unicode, `~` in ASCII fallback), gray (brief-
  specific; no run-tui node analog)

#### Scenario: Brief-list and run-tui status pane glyphs match across shared statuses

- **WHEN** a brief-list row for `queued` (or `running`,
  `succeeded`, `failed`) is rendered alongside a run-tui
  status pane node row in the corresponding `pending` (or
  `running`, `succeeded`, `failed`) status, both at the same
  glyph set (UTF-8 or ASCII)
- **THEN** the glyph string emitted for the row and the
  applied color token SHALL be equal between the two panes.
  An automated test SHALL assert this equality for all four
  shared statuses; the test SHALL fail if either pane is
  later tweaked without the other (e.g. a glyph-table edit
  on one side that does not propagate to the other)
