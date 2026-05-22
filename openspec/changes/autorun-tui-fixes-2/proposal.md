## Why

The previous `autorun-tui-fixes` round (archived as
`2026-05-22-autorun-tui-fixes`) was meant to give the autorun TUI a
true three-column drilled-in layout (`briefs | nodes | events`) by
extracting a shared `RunBody` component. It shipped the component
and a snapshot named "three vertical regions: briefs | nodes |
events" — but the layout in real terminals is still two columns:
`briefs | (nodes-stacked-over-events)`.

The bug is a one-line mismatch in `src/tui/autorun-app.tsx:238`:
the Box that wraps the embedded `RunBody` is declared with
`flexDirection="column"`. `RunBody` is a fragment whose children
(status pane, vertical rule, log pane) rely on the parent's flex
direction being `row`. `RunApp` mounts `RunBody` inside a default-
`row` Box and gets the three-column shape; `AutorunApp` mounts it
inside an explicit `column` Box and stacks the children vertically.
The committed snapshot froze the buggy shape, so the regression
sailed through review.

Two adjacent presentation gaps surface alongside the layout bug:

1. **Embedded spinner never ticks.** The selected brief's run-state
   spinner stays static while a node runs, because
   `src/tui/autorun-renderer.tsx`'s 100ms tick loop only dispatches
   into the autorun reducer (animating brief-list spinners) and
   never dispatches a `tick` into the embedded `RunState`. The
   per-node spinner needs `runReducer({ kind: "tick" })` the same
   way `minifac run`'s TUI ticks it.
2. **Brief-list ↔ node-row glyph / color parity is undocumented and
   under-tested.** The two panes happen to share their glyph table
   today (both route running through `<Spinner>`, succeeded/failed
   through `●`, queued/pending through `○`), but the parity is not
   asserted anywhere and the spec's "Brief status glyphs" table
   spells the running glyph as `◔` rather than referencing the
   shared `<Spinner>` from `run-tui`. A future tweak to one side
   will silently drift from the other.

This is a presentation-only change to the TUI layer. The autorun
scheduler, lockfile, run primitive, persistence, and
`AutorunEvent` shape are unchanged.

## What Changes

- **MODIFIED** `autorun-tui` — strengthen the "Autorun TUI layout"
  requirement so the drilled-in body MUST contain two vertical
  rules (between brief-list and nodes pane, and between nodes
  pane and log pane), independent of any committed snapshot.
  Add a scenario that asserts the two-rule invariant so this
  class of regression cannot pass review again by approving a
  wrong snapshot.
- **MODIFIED** `autorun-tui` — strengthen the "Embedded run-mode
  view reuses run-tui" requirement to spell out that the
  per-node spinner glyph in the drilled-in view SHALL animate
  while any node is in a running-ish status, driven by the same
  `runReducer({ kind: "tick" })` mechanism `minifac run`'s TUI
  uses. The autorun TUI MUST NOT invent a parallel spinner
  clock.
- **MODIFIED** `autorun-tui` — replace the standalone running
  glyph (`◔`) in the "Brief status glyphs" requirement table
  with a reference to the shared `<Spinner>` component from
  `run-tui`'s status pane, and add a scenario asserting that
  brief-list rows render the same glyph + color tokens as the
  per-node rows in `run-tui`'s status pane across the four
  shared statuses (queued/pending, running, succeeded, failed).
  `skipped` keeps its own brief-specific glyph (`↷` / `~`, gray)
  because no analog exists on the node side.
- The autorun scheduler, lockfile, run primitive, persistence
  layer, and `AutorunEvent` shape are **unchanged**.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `autorun-tui` — strengthen the three layout / parity
  requirements named above. No new capability surface; the
  reducer, hotkey contract, and TUI-does-not-change-autorun
  requirements are unaffected.
