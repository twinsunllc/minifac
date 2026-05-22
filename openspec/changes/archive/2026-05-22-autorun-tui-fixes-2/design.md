## Context

The first `autorun-tui-fixes` round merged at `c1dac2c`. It
extracted `RunBody` from `RunApp` so that `AutorunApp` could
reuse the same `status | log` composition for its drilled-in
right region. The extraction is correct; the wiring is not.

`RunBody` is a fragment of three sibling children:
`StatusPane`, a vertical-rule Box, and `LogPane`. Ink's `Box`
defaults to `flexDirection: "row"`, so siblings sit
horizontally unless the parent overrides direction. `RunApp`
mounts `RunBody` inside a default-row Box and gets three
visible columns. `AutorunApp` at line 238 mounts `RunBody`
inside `<Box flexDirection="column" flexGrow={1}>` — the
column direction stacks the three siblings on top of each
other, producing the `nodes-over-events` shape that ships
today.

A committed snapshot in
`src/tui/__snapshots__/autorun-app.test.tsx.snap` titled
"three vertical regions: briefs | nodes | events" actually
snapshots the buggy two-column frame. So an automated test
asserting "matches the snapshot" passes against the bug, and
a human reviewer scanning the snapshot file sees the title
and assumes the layout is right.

This change tightens the spec so the invariant ("two vertical
rules in the drilled-in body row") is enforceable by an
assertion that doesn't depend on the snapshot's contents.

## Goals / Non-Goals

**Goals:**

- The drilled-in body in a ≥80×24 terminal renders three
  visible columns separated by two vertical rules.
- The embedded run-state spinner animates whenever a node is
  in a running-ish status, driven by the same `runReducer`
  tick mechanism `minifac run` uses.
- Brief-list glyphs and colors match the run-tui status-pane
  node-row across queued/pending, running, succeeded, failed.
  Drift in either direction is caught by a test.

**Non-Goals:**

- No changes to `RunBody`, `RunApp`, the run-mode TUI, or the
  brief-list reducer's state shape.
- No new keybinds, flags, or event types.
- No changes to the autorun scheduler, lockfile, run
  primitive, persistence, or `AutorunEvent` shape.
- No changes to the `skipped` brief-only glyph (`↷` / `~`,
  gray) — no run-tui node analog exists.

## Decisions

### Spec the layout invariant as "two vertical rules in the body row," not "uses Box default row"

The bug is mechanistically a `flexDirection` mismatch, but
the spec should constrain the *visible* outcome: two
vertical-rule glyphs in the drilled-in body row at any
terminal size ≥ 80 cols. That invariant survives future
refactors that might change which component mounts `RunBody`
or how the rule is drawn.

### Tick the embedded `RunState` from the existing 100ms loop

The autorun renderer already runs a 100ms tick loop in
`src/tui/autorun-renderer.tsx:127-134` for brief-list
spinners. The cleanest fix is to extend that loop to also
dispatch a `runReducer({ kind: "tick" })` into the
currently-selected brief's `runState` slot when any of its
nodes is running. This keeps a single tick clock for the
process and avoids the run-mode TUI's separate tick effect
running inside the autorun TUI's component tree (which would
require mounting parts of `RunApp` that the autorun TUI
deliberately does not mount).

Rejected alternative: mount the whole `<RunApp>` inside the
right region, inheriting its tick effect for free. This was
rejected in the earlier round (favoring shared-`RunBody`
extraction over nested-`RunApp` embedding) to avoid
double-rendering the run-mode header / hotkey bar inside the
autorun chrome. That decision still holds.

### Glyph + color parity asserted by token comparison, not by snapshot

The brief-list and run-tui status panes already happen to
agree on glyphs and colors today, but the spec previously
documented the brief-list running glyph as `◔` while the
implementation routes through `<Spinner>` (braille frames).
The spec is the bit that's out of step. Strengthen the
"Brief status glyphs" requirement to point at the run-tui
status-pane node-row as the source of truth for the shared
states, and require a parity test that pulls the rendered
glyph + color tokens from both panes and asserts equality.

## Risks / Trade-offs

- **Risk:** Ticking the embedded `RunState` from the autorun
  reducer means a `setState` per 100ms while any node is
  running, on top of the brief-list `setState`. In practice
  these are merged by React's batching and the impact is the
  same per-frame cost `minifac run` already pays.
- **Trade-off:** Documenting parity via "matches run-tui's
  status pane" rather than a literal glyph table makes the
  spec slightly less self-contained, but it is the only way
  to keep the two panes from drifting under future edits.

## Migration Plan

No migrations. This is presentation-only. After the change
lands, the snapshot file is regenerated from the corrected
code; reviewers should eyeball the regenerated snapshot to
confirm three distinct columns separated by vertical rules.

## Open Questions

None — the affected surface is narrow and the fixes are
mechanically constrained.
