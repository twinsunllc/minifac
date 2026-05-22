## MODIFIED Requirements

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

The reducer SHALL treat `skipped` events as transitions out of
`queued` (or out of a prior `skipped`) only. When a `skipped`
event arrives for a `BriefRowState` whose current status is
`running`, `succeeded`, or `failed`, the reducer SHALL leave
the row unchanged: the `status` SHALL remain `running` /
`succeeded` / `failed`, no `skipReason` SHALL be introduced, and
the embedded `RunState` slot (if any) SHALL be preserved. The
three states `running`, `succeeded`, and `failed` are owned by
the `started` and `completed` events; `skipped` SHALL NOT
override them. This rule applies regardless of the `skipped`
event's `reason` (`in-flight`, `activity-running`,
`activity-succeeded`, `activity-failed`, `blocked`, or any
future reason string the scheduler emits to re-affirm an
existing state on a poll cycle). The `dry-run-decision` handler
SHALL retain its existing semantics and is NOT subject to this
rule; dry-run decisions reflect hypothetical scheduling with no
live run state to protect.

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
