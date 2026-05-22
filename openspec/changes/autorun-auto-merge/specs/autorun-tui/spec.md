## MODIFIED Requirements

### Requirement: Brief-list event reducer

The `autorun-tui` capability SHALL expose a pure event-reducer
function `autorunReducer(state, event) → state` that maps a
`BriefListState` and a single event into the next
`BriefListState`. The reducer SHALL accept two kinds of input
events:

- **Autorun events**: the `AutorunEvent` shape produced by the
  autorun process (per the `auto-mode` capability's "Autorun
  structured logging" requirement and the additional
  `auto-merge-failed` kind defined by the `auto-mode`
  capability's "Autorun auto-merge-failed event" requirement)
  — `poll-start`, `started`, `skipped`, `completed`, `failed`,
  `dry-run-decision`, `startup`, `info`, `auto-merge-failed`.
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
  `succeeded`, `failed`, `skipped`, `succeeded-but-unmerged`),
  optional `runId` once a `started` event has been observed,
  optional `skipReason` when `status === "skipped"`, optional
  `autoMergeFailReason` when
  `status === "succeeded-but-unmerged"` (carrying the
  `auto-merge-failed` event's `reason` enum value), and an
  optional embedded per-run state slot (the `RunState` shape
  from the `run-tui` capability) populated for any brief whose
  run has produced events.
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

The reducer SHALL treat `skipped` events as transitions out of
`queued` (or out of a prior `skipped`) only. When a `skipped`
event arrives for a `BriefRowState` whose current status is
`running`, `succeeded`, `failed`, or `succeeded-but-unmerged`,
the reducer SHALL leave the row unchanged: the `status` SHALL
remain in its current state, no `skipReason` SHALL be
introduced, and the embedded `RunState` slot (if any) SHALL be
preserved. The states `running`, `succeeded`, `failed`, and
`succeeded-but-unmerged` are owned by the `started`,
`completed`, and `auto-merge-failed` events; `skipped` SHALL
NOT override them. This rule applies regardless of the
`skipped` event's `reason` (`in-flight`, `activity-running`,
`activity-succeeded`, `activity-failed`, `blocked`, or any
future reason string the scheduler emits to re-affirm an
existing state on a poll cycle). The `dry-run-decision`
handler SHALL retain its existing semantics and is NOT subject
to this rule; dry-run decisions reflect hypothetical scheduling
with no live run state to protect.

The reducer SHALL transition a brief to
`succeeded-but-unmerged` only on an `auto-merge-failed` event
whose `change` matches a row currently in status `succeeded`.
The transition SHALL preserve `runId` (sourced from the
preceding `completed` event), SHALL preserve the embedded
`RunState` slot, SHALL set `autoMergeFailReason` to the
event's `reason` value, and SHALL clear `skipReason` if
present. An `auto-merge-failed` event whose `change` matches a
row in `running`, `queued`, `failed`, `skipped`, or
`succeeded-but-unmerged` (already-transitioned) SHALL leave
the row's `status` unchanged but SHALL still update
`autoMergeFailReason` if the row is
`succeeded-but-unmerged` (so the latest reason wins). For a
row in `running`, `queued`, `failed`, or `skipped`, the
`auto-merge-failed` event arriving without a preceding
`succeeded` is a protocol violation; the reducer SHALL leave
the row unchanged and SHALL NOT crash (the raw logger still
emits the event so the operator sees it in the log stream).

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

#### Scenario: skipped event does NOT override a running row

- **WHEN** the reducer receives a `started` event for change
  `foo` (so its status becomes `running`) and subsequently
  receives a `skipped` event for change `foo` with reason
  `in-flight` on the next poll cycle
- **THEN** the returned state has the `foo` row with
  `status = "running"` (unchanged); `skipReason` is `undefined`
  (no reason is introduced); the embedded `runState` slot is
  preserved. The same outcome holds for a `skipped` event with
  reason `activity-running` against a `running` row

#### Scenario: skipped event does NOT override a succeeded or failed row

- **WHEN** the reducer receives, in order, a `started` event
  for change `foo`, a `completed` event for change `foo` with
  `status: "succeeded"`, and then a `skipped` event for change
  `foo` with reason `activity-succeeded` on a subsequent poll
- **THEN** the final state has the `foo` row with
  `status = "succeeded"` (unchanged); `skipReason` is
  `undefined` (no reason is introduced); the embedded
  `runState` slot is preserved

- **WHEN** the same sequence ends with `completed` carrying
  `status: "failed"` followed by a `skipped` event with reason
  `activity-failed`
- **THEN** the final state has the `foo` row with
  `status = "failed"` (unchanged) and `skipReason ===
  undefined`

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

#### Scenario: auto-merge-failed transitions succeeded to succeeded-but-unmerged

- **WHEN** the reducer receives, in order, a `started` event
  for change `foo`, a `completed` event for change `foo` with
  `status: "succeeded"`, and an `auto-merge-failed` event for
  change `foo` with `reason: "conflict"`
- **THEN** the final state has the `foo` row with
  `status = "succeeded-but-unmerged"`,
  `autoMergeFailReason = "conflict"`, `runId` preserved from
  the `completed` event, and the embedded `RunState` slot
  preserved

#### Scenario: auto-merge-failed without preceding succeeded is a no-op

- **WHEN** the reducer receives an `auto-merge-failed` event
  for change `foo` whose current row is in status `running`
  (no preceding `completed` event has arrived)
- **THEN** the row's `status` remains `running` and the row's
  `autoMergeFailReason` remains `undefined`; the reducer does
  not crash and does not transition the row to
  `succeeded-but-unmerged`

#### Scenario: subsequent auto-merge-failed updates the reason

- **WHEN** the reducer is in a state where `foo` is
  `succeeded-but-unmerged` with `autoMergeFailReason =
  "conflict"` and receives a subsequent `auto-merge-failed`
  event for `foo` with `reason: "dirty-working-tree"` (e.g.
  the operator dirtied the tree and another autorun cycle
  re-attempted)
- **THEN** the row's `status` remains
  `succeeded-but-unmerged` and `autoMergeFailReason` is
  updated to `"dirty-working-tree"` (latest reason wins)

### Requirement: Brief status glyphs

The `autorun-tui` capability SHALL render each brief row's status
as a single glyph in the brief-list pane. For the four statuses
that have a direct analog in the `run-tui` capability's node
status table (queued/pending, running, succeeded, failed), the
brief-list pane SHALL render the SAME glyph and the SAME color
the `run-tui` capability's status pane renders for the
corresponding node status (per its "TUI layout" requirement),
so that the visual vocabulary is identical between the two
panes. The `skipped` and `succeeded-but-unmerged` brief statuses
have no node analog and keep their own brief-specific glyph and
color.

The mapping SHALL be:

| Brief status | Glyph / color | Source of truth |
|--------------|---------------|-----------------|
| `queued` | open circle (`○` Unicode / `.` ASCII), gray | run-tui status pane `pending` row |
| `running` | shared `<Spinner>` braille frames (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` Unicode / `\|/-\` ASCII), yellow | run-tui status pane `running` row |
| `succeeded` | filled circle (`●` Unicode / `o` ASCII), green | run-tui status pane `succeeded` row |
| `failed` | filled circle (`●` Unicode / `!` ASCII), red | run-tui status pane `failed` row |
| `skipped` | `↷` Unicode / `~` ASCII, gray | brief-specific (no node analog) |
| `succeeded-but-unmerged` | half circle (`◐` Unicode / `*` ASCII), yellow | brief-specific (no node analog) |

When the runtime environment does not advertise a UTF-8 locale
(per the `run-tui` capability's "TUI layout" requirement), the
TUI SHALL substitute ASCII glyphs per the table above. The
ASCII fallback policy SHALL be inherited from the `run-tui`
capability's glyph table for the four shared states; the
brief-specific `skipped` (`~`) and `succeeded-but-unmerged`
(`*`) ASCII glyphs are the only autorun-owned ASCII glyphs.

The brief-list pane SHALL apply the status color to BOTH the
glyph cell and the brief change-name cell on the row (matching
the run-tui status pane's behavior of coloring both the glyph
and the node id). A drift between glyph color and label color
on either side SHALL be considered a regression.

The brief-list pane SHALL render a `succeeded-but-unmerged`
row with a trailing suffix carrying the
`autoMergeFailReason` value when present, so the operator
sees at a glance why the merge failed without drilling in.
The suffix SHALL be formatted as ` (unmerged: <reason>)` in
both Unicode and ASCII modes; the color of the suffix SHALL
match the row color (yellow) per the dual-coloring rule
above.

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

#### Scenario: succeeded-but-unmerged brief renders with the half-circle glyph

- **WHEN** a brief's `status` is `succeeded-but-unmerged`
  with `autoMergeFailReason = "conflict"`
- **THEN** the brief-list pane's row shows the half-circle
  glyph (`◐` in Unicode, `*` in ASCII fallback), yellow,
  followed by the trailing suffix ` (unmerged: conflict)`;
  both the glyph and the change-name and the suffix carry
  the yellow color token

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
