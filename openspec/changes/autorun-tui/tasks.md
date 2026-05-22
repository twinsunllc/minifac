## 1. CLI flag plumbing

- [ ] 1.1 Add `--raw` and `--tui` boolean options to the
      `autorun` command in `src/cli.ts`, in the same shape the
      `run` command already declares them.
- [ ] 1.2 Extend `AutorunOptions` (in `src/cli/autorun.ts`)
      with `raw?: boolean` and `tui?: boolean` fields and
      thread them through `validateOptions`.
- [ ] 1.3 Reuse the existing `pickOutputMode` helper from
      `src/cli.ts` (do NOT duplicate the function). Add the
      `--tui` + `--json` mutual-exclusion check up front and
      the `--json` + TTY → raw fallback before reaching
      `pickOutputMode`.
- [ ] 1.4 `--raw` + `--tui` together SHALL exit `1` with the
      flag-conflict stderr message before any poll cycle runs.

## 2. Brief-list event reducer

- [ ] 2.1 Create `src/tui/autorun-reducer.ts` exporting
      `BriefListState`, `BriefRowState`, `BriefStatus`, and
      `autorunReducer(state, event) → state`.
- [ ] 2.2 Implement run-event cases (`startup`, `poll-start`,
      `started`, `completed`, `skipped`, `failed`,
      `dry-run-decision`, `info`) per the `autorun-tui`
      capability's "Brief-list event reducer" requirement.
- [ ] 2.3 Implement UI-event cases (`select-brief-next`,
      `select-brief-prev`, `enter-brief`, `back-to-list`,
      `request-quit`, `confirm-quit`, `cancel-quit`,
      `toggle-help`).
- [ ] 2.4 Add `src/tui/autorun-reducer.test.ts` covering every
      scenario in the spec (mirror the structure of
      `src/tui/reducer.test.ts`).

## 3. Brief-list pane component

- [ ] 3.1 Create `src/tui/brief-list-pane.tsx` rendering one
      row per `BriefRowState` with status glyph + change name
      + (when present) the skip reason or run id suffix.
- [ ] 3.2 Reuse the existing `src/tui/glyphs.ts` set; add the
      skipped glyph (`↷` / `~`) to the Unicode / ASCII tables.
- [ ] 3.3 Reuse the existing `src/tui/spinner.tsx` for the
      animated `running` glyph.
- [ ] 3.4 Add a snapshot test that exercises all five
      `BriefStatus` rows (queued, running, succeeded, failed,
      skipped) in both Unicode and ASCII glyph modes.

## 4. Autorun app + route wiring

- [ ] 4.1 Create `src/tui/autorun-app.tsx` exporting
      `<AutorunApp>` that composes the bordered outer Box, the
      header zone, the body zone (brief-list pane + embedded
      `<RunApp>` from `src/tui/app.tsx`), and the hotkey bar.
- [ ] 4.2 Implement the empty-state hint
      ("Press ↑/↓ to select a brief, Enter to drill in") for
      when no brief is selected.
- [ ] 4.3 Wire focus routing (`focus = "brief-list"` vs
      `"run-view"`) so the brief-list hotkeys (`↑/↓/j/k`,
      `Enter`) operate against `autorunReducer` and the
      drilled-in hotkeys delegate to the existing
      `runReducer` per the `run-tui` capability.
- [ ] 4.4 Bind `Esc` (only when `focus = "run-view"`) to
      produce `back-to-list`; bind `r` and `q` at the
      autorun TUI level (not delegated to the embedded
      run-mode view).
- [ ] 4.5 Implement the sub-80×24 single-pane collapse per
      the spec.

## 5. Autorun renderer adapter

- [ ] 5.1 Create `src/tui/autorun-renderer.ts` exporting
      `createInkAutorunRenderer({ ... }) → { onEvent(autorunEvent),
      onRunEvent(change, nodeEventEntry), waitForExit() →
      Promise<{exitCode, action: "quit" | "raw-switch"}>,
      requestQuit() }`. Owns the ink `render()` lifecycle.
- [ ] 5.2 `onEvent` dispatches each `AutorunEvent` into
      `autorunReducer` and triggers a re-render.
- [ ] 5.3 `onRunEvent(change, entry)` looks up the brief's
      `RunState` slot, runs `runReducer` against it, and
      writes the updated slot back into `BriefListState`.
- [ ] 5.4 The `r` hotkey unmounts ink and resolves
      `waitForExit()` with `action: "raw-switch"` so the CLI
      can rewire the autorun logger to its existing human /
      JSON formatter for the remainder of the autorun lifetime.
- [ ] 5.5 The `q` hotkey on a no-in-flight state quits
      immediately; mid-drain `q` initiates the autorun
      graceful-shutdown path via `requestQuit()`; a second
      `q` escalates per the `auto-mode` capability's
      "Autorun TUI mid-run quit semantics" requirement.

## 6. Autorun action integration

- [ ] 6.1 In `src/cli/autorun.ts`, after `validateOptions`,
      resolve the output mode via the new flags + helper.
- [ ] 6.2 In raw mode, keep today's `makeLogger` /
      scheduler callbacks unchanged.
- [ ] 6.3 In TUI mode, construct an `InkAutorunRenderer` and
      fan out scheduler callbacks (`onStarted`, `onCompleted`,
      `onError`) to both the renderer's `onEvent` AND
      (optionally for tests) the existing logger; the
      existing logger SHALL NOT write to stdout while the TUI
      is mounted.
- [ ] 6.4 Extend `AutorunRunFactory` (in
      `src/cli/autorun-scheduler.ts` or its types) with an
      optional per-event callback `onRunEvent?: (entry:
      NodeEventEntry) => void`. Thread it through
      `buildDefaultRunFactory` so the run primitive's
      `onEvent` callback fans into the TUI renderer's
      `onRunEvent(change, entry)`.
- [ ] 6.5 On `action: "quit"` from the renderer, invoke the
      same drain-and-exit logic the SIGINT handler runs; on
      `action: "raw-switch"`, swap the autorun event sink back
      to the human / JSON formatter for the remainder of the
      process.
- [ ] 6.6 Preserve the existing final stderr summary lines
      after ink unmounts so scripts grepping stderr still see
      them.

## 7. CLI mode-selection tests

- [ ] 7.1 Add `src/cli.autorun-tui.test.ts` mirroring
      `src/cli.tui.test.ts` shape: `process.stdout.isTTY =
      true` with no flags routes the `autorun` action to the
      TUI path (assert the renderer is constructed; the human
      logger is NOT called with `started` / `completed`
      events).
- [ ] 7.2 `process.stdout.isTTY = false` with no flags routes
      the `autorun` action to the raw path (assert today's
      log lines are produced; the renderer is NOT
      constructed).
- [ ] 7.3 `--raw` forces raw in a TTY; `--tui` forces TUI in
      a non-TTY.
- [ ] 7.4 `--raw --tui` together exits `1` with the flag-
      conflict stderr message and starts no poll cycle.
- [ ] 7.5 `--tui --json` together exits `1` with the flag-
      conflict stderr message.
- [ ] 7.6 `--json` on a TTY without `--tui` keeps emitting
      JSON on stdout (no TUI is mounted).

## 8. Autorun TUI render snapshot tests

- [ ] 8.1 Using `ink-testing-library`, render `<AutorunApp>`
      with an empty `BriefListState` and snapshot the empty-
      state frame.
- [ ] 8.2 Snapshot a state with one brief in each status
      (queued, running, succeeded, failed, skipped).
- [ ] 8.3 Snapshot the drilled-in state (`focus =
      "run-view"`) with a populated embedded `RunState` —
      verify the brief-list pane stays visible on the left
      and the embedded run view renders on the right.
- [ ] 8.4 Snapshot the sub-80×24 single-pane fallback for
      both focus states.
- [ ] 8.5 Snapshot the help overlay (`?`).
- [ ] 8.6 Snapshot the mid-drain hotkey bar (after the user
      pressed `q` and at least one run is still in flight).

## 9. Hotkey behavior tests

- [ ] 9.1 Test `↓` / `j` and `↑` / `k` move brief-list
      selection without leaving the brief-list focus.
- [ ] 9.2 Test `Enter` on a brief with a populated
      `RunState` slot flips focus to `run-view`; `Enter` on
      a queued / skipped brief is a no-op.
- [ ] 9.3 Test `Esc` from `run-view` returns to
      `brief-list` and preserves the embedded `RunState`.
- [ ] 9.4 Test `r` unmounts ink and resolves the renderer's
      `waitForExit()` with `action: "raw-switch"`.
- [ ] 9.5 Test `q` with no in-flight runs quits immediately
      (exit `0`); `q` with in-flight runs initiates drain
      and keeps the TUI mounted until the drain completes; a
      second `q` while draining escalates and exits `2`.
- [ ] 9.6 Test `?` toggles the help overlay.

## 10. Documentation

- [ ] 10.1 Update `docs/concepts/Auto-Mode.md` (or create the
      file if it does not exist yet) to mention the TUI is
      the default in a TTY and `--raw` is the escape hatch
      for scripts and CI.
- [ ] 10.2 Update `README.md` quickstart to mention the
      autorun TUI alongside the run TUI; call out `--raw` for
      pipelines.

## 11. Acceptance

- [ ] 11.1 `minifac autorun` in a TTY shows the autorun TUI.
- [ ] 11.2 `minifac autorun > log` (non-TTY) falls back to
      raw output with no behavior change vs today.
- [ ] 11.3 `--raw`, `--tui`, and the `--tui` + `--json`
      conflict all behave per the spec.
- [ ] 11.4 Selecting a brief drills into the existing run-
      mode TUI for that brief's run; selecting a node within
      it shows its log stream.
- [ ] 11.5 Existing `--raw` and `--json` autorun output is
      byte-identical to today.
- [ ] 11.6 All existing tests still pass.
- [ ] 11.7 `npm run build` is clean.
- [ ] 11.8 `openspec validate autorun-tui` exits `0`.
