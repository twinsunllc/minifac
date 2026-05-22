# Tasks

## 1. Three-column drilled-in body

- [x] 1.1 Choose the implementation path: embed `<RunApp>` directly in
      the autorun TUI's right region (with input disabled and outer
      chrome suppressed), OR extract `RunApp`'s body composition into
      a shared `RunBody` component used by both `RunApp` and
      `AutorunApp`. The shared-component path is preferred to avoid
      nested header / hotkey bars; the embed path is acceptable if
      cleaner.
- [x] 1.2 Replace `src/tui/autorun-app.tsx`'s local `RunView`
      (currently `flexDirection: "column"` over `<StatusPane>` +
      `<LogPane>`) with the chosen implementation. Remove the
      duplicate layout code.
- [x] 1.3 Verify `bodyHeight` (the value `RunApp` passes to
      `<LogPane>`'s `height` prop) is plumbed through the embed path
      so log-pane scroll math uses the bounded outer height, matching
      `RunApp`'s behavior.
- [x] 1.4 Manually drive the TUI against a real autorun session and
      confirm the drilled-in body reads as `briefs | nodes | events`
      (three vertical regions, vertical rules between them). Capture
      a screenshot or terminal-recorded frame for the PR.

## 2. Brief-list row transitions

- [x] 2.1 Root-cause why rows appear stuck on their initial skip
      reason in real autorun sessions. Suspects ranked from most to
      least likely:
      - The scheduler emits another `skipped` event on the next poll
        (e.g. `activity-running` from an orphan `runs.db` row left by
        a killed prior run), so the row stays at `skipped` for the
        actual scheduler reason — not a presentation bug. If this is
        the case, file the orphan-recovery brief and confirm the TUI
        is rendering the scheduler's view correctly.
      - The renderer's `bridgeRef.current?.onEvent` path captures a
        stale closure of `state` and `setState` produces an outdated
        merge. Check `src/tui/autorun-renderer.tsx`'s `useEffect`
        deps and the bridge `getState` accessor.
      - The reducer's `upsertBrief` does not deep-clone the row when
        a non-`skipped` transition omits the `skipReason` key (e.g.
        the spread retains a key from a previous row). Verify by
        running the new sequence test from task 2.3.
- [x] 2.2 Fix whichever of the above the root-cause work identifies.
      If the root cause is upstream (scheduler), file/cross-link the
      `autorun-orphan-recovery` brief and leave a note in this PR;
      no scheduler change lands in this PR.
- [x] 2.3 Add a reducer test in `src/tui/autorun-reducer.test.ts`
      that walks `skipped (reason: "activity-succeeded")` → `started`
      → `completed (status: "succeeded")` and asserts:
      - `briefs[0].status === "succeeded"`
      - `briefs[0].skipReason === undefined`
      - `briefs[0].runId` is populated
- [x] 2.4 Add a sibling reducer test that ends with `completed
      (status: "failed")` and asserts `status === "failed"` and
      `skipReason === undefined`.

## 3. Snapshot test for the three-column drilled-in frame

- [x] 3.1 Add an ink-testing-library test in
      `src/tui/autorun-app.test.tsx` (or extend an existing test
      file) that mounts `<AutorunApp>` with:
      - terminal size 100×30 (well above the 80×24 compact
        threshold),
      - a `BriefListState` containing at least two briefs, one of
        which has a populated `runState` slot with at least one
        node and one emitted event,
      - `focus = "run-view"`, `selectedBriefIndex` pointing at the
        brief with the populated `runState`.
- [x] 3.2 Snapshot the rendered frame. The snapshot SHALL clearly
      show three vertical regions in the body (brief-list, nodes
      pane, log pane). Add inline assertions or comments next to the
      snapshot that name what each region is, so a future reviewer
      can read the expected shape without running the test.
- [x] 3.3 If shared-`RunBody` extraction lands as part of task 1,
      add a sibling test that renders `<RunApp>` against the same
      `RunState` at the same width and confirms its body shape
      matches the autorun TUI's drilled-in right region (sanity
      check for the "embedded body matches run-mode" scenario in the
      spec).

## 4. Verification

- [x] 4.1 `npm test` passes — all existing tests still green, new
      reducer and snapshot tests pass.
- [x] 4.2 `npm run build` is clean (strict TypeScript, biome
      formatting / linting).
- [x] 4.3 Drive `minifac autorun` against the `inputs/` directory by
      hand against at least two briefs that exercise both the
      drilled-in three-column body and the skipped → started →
      completed transition. Confirm the operator sees both fixes.
- [x] 4.4 Update `docs/concepts/` only if the body-shape clarification
      surfaces a doc gap; otherwise leave docs alone (the capability
      spec is the source of truth).
