# Tasks

## 1. Fix the drilled-in three-column layout

- [x] 1.1 In `src/tui/autorun-app.tsx`, remove the explicit
      `flexDirection="column"` from the Box at line 238 that
      wraps `<RunBody>`. Use the Ink default (`row`) so the
      `RunBody` fragment's three children (status pane,
      vertical rule, log pane) lay out side-by-side as
      `RunApp` already does.
- [x] 1.2 Manually drive the autorun TUI against a real
      autorun session in a ≥80×24 terminal and confirm the
      drilled-in body reads as three vertical regions
      separated by two vertical rules: `briefs (24) | nodes
      (24) | events (flex)`. Capture a terminal frame for
      the PR description.

## 2. Replace the misleading three-column snapshot

- [x] 2.1 Regenerate the snapshot named "three vertical
      regions: briefs | nodes | events" in
      `src/tui/__snapshots__/autorun-app.test.tsx.snap` from
      the corrected `AutorunApp` (after task 1.1).
- [x] 2.2 Visually inspect the regenerated snapshot in the
      diff: confirm the body row contains two `│` vertical-
      rule glyphs and three labeled regions. Note the
      eyeball check in the PR description.
- [x] 2.3 Add an explicit assertion in
      `src/tui/autorun-app.test.tsx` (alongside the
      regenerated snapshot) that counts the vertical-rule
      glyphs in the drilled-in body row and asserts the
      count equals two. The assertion SHALL be independent
      of snapshot matching, so a future buggy snapshot
      regeneration cannot pass review.

## 3. Animate the embedded per-node spinner

- [x] 3.1 Extend the 100ms tick loop in
      `src/tui/autorun-renderer.tsx` (currently lines
      127–134) so that, in addition to dispatching the
      autorun-reducer `tick` when any brief is in `running`,
      it also dispatches `runReducer({ kind: "tick" })` into
      the currently-selected brief's `runState` slot when
      that slot exists and any of its nodes has status
      `running` or `retrying`.
- [x] 3.2 Use the existing `dispatchRun` path (or an
      equivalent setState that goes through `runReducer`) so
      the run-mode tick semantics are preserved verbatim. Do
      NOT introduce a parallel spinner clock or a separate
      tick effect.
- [x] 3.3 Guard the run-state tick so it does NOT fire when
      no node is running (idle briefs do not pay a per-frame
      `setState` cost).
- [x] 3.4 Add a renderer test in
      `src/tui/autorun-renderer.test.tsx` (or extend an
      existing test) that mounts the renderer with a brief
      whose `runState` contains a `running` node, advances
      fake timers by ~300ms, and asserts the brief's
      `runState.tick` value advanced — independently of any
      ink-render snapshot.

## 4. Brief-list ↔ run-tui status-pane glyph + color parity

- [x] 4.1 Audit `src/tui/brief-list-pane.tsx`'s `colorFor`,
      `glyphFor`, and `BriefRow` against
      `src/tui/status-pane.tsx`'s `colorForStatus`,
      `statusGlyph`, and `StatusRow` for the four shared
      states (queued↔pending, running, succeeded, failed).
      Confirm glyph string, applied color, and color-to-
      label application are identical. Fix any drift found
      (e.g. label color, marker width).
- [x] 4.2 Add a parity test in a new file
      `src/tui/brief-list-pane.parity.test.tsx` (or extend
      `src/tui/brief-list-pane.test.tsx`) that renders one
      row at each of the four shared statuses through both
      `<BriefListPane>` (with a one-brief
      `BriefListState`) and `<StatusPane>` (with a one-node
      `RunState`), extracts the glyph cell and the label
      cell from each rendered frame, and asserts the glyph
      string + color token match between the two panes for
      every shared status. The test SHALL fail if a future
      edit to one side does not propagate to the other.
- [x] 4.3 Confirm `skipped` is excluded from the parity test
      (brief-specific glyph, no node analog), but is still
      covered by an existing scenario / test that asserts
      its glyph + color.

## 5. Validation

- [x] 5.1 Run `openspec validate autorun-tui-fixes-2 --strict`
      and ensure it exits 0.
- [x] 5.2 Run `npm test` and ensure all tests pass.
- [x] 5.3 Run `npm run build` and ensure it exits clean.
