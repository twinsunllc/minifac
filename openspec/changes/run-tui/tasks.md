## 1. Dependencies and tooling

- [x] 1.1 `npm install ink react @types/react` and verify
      `package.json` carries the new runtime deps; `npm install -D
      ink-testing-library` for the test surface.
- [x] 1.2 Confirm `tsconfig.json` sets `jsx: "react-jsx"` (or
      `react`) so `.tsx` files under `src/tui/` compile cleanly.
- [x] 1.3 Add a biome (or other linter) carveout for `.tsx` files
      mirroring the existing config style, if biome complains
      about JSX.
- [x] 1.4 Verify `npm run build` and `npm test` still pass after
      the dependency bump but before any TUI code lands.

## 2. Event reducer (pure)

- [x] 2.1 Create `src/tui/reducer.ts` exporting `RunState`,
      `NodeState`, `IterationLog`, `RenderedEvent`, and
      `runReducer(state, event) → state`.
- [x] 2.2 Implement run-event cases (`stdout`, `stderr`,
      synthetic `status`) per the `run-tui` capability's "TUI
      event reducer" requirement: first `stdout` event for a
      pending node moves it to running; a `status` event sets
      the iteration's terminal status; another `stdout` after
      `failed` starts a new iteration.
- [x] 2.3 Implement UI-event cases (`navigate-up`,
      `navigate-down`, `enter-follow`, `cycle-iteration-prev`,
      `cycle-iteration-next`, `scroll-log-up`,
      `scroll-log-down`, `toggle-details`, `request-quit`,
      `confirm-quit`, `cancel-quit`, `toggle-help`,
      `terminate-run`).
- [x] 2.4 Add `src/tui/reducer.test.ts` covering every case in
      the spec's reducer scenarios.

## 3. Event rendering

- [x] 3.1 Create `src/tui/event-rendering.ts` exporting
      `renderStreamJsonLine(line) → RenderedEvent` and
      `renderNodeEvent(entry) → RenderedEvent`.
- [x] 3.2 Implement the per-event-type rules from the spec's
      "Stream-json log rendering rules" requirement: suppress
      `system / init`; suppress non-rejected `rate_limit_event`;
      highlight rejected; render `assistant / text` as prose;
      `assistant / tool_use` as `→ ToolName(short args)`;
      `user / tool_result` as `✓ ...` or `✗ ...`; `result` as
      a terminal-status line; synthetic `status` highlighted;
      unparseable as `kind: "raw"`.
- [x] 3.3 Implement the ~80-char one-liner truncation with
      ellipsis (whitespace collapse first) and unit-test it.
- [x] 3.4 Add `src/tui/event-rendering.test.ts` covering every
      rendering rule and the details (`fullJson`) field.

## 4. Glyphs and spinner

- [x] 4.1 Create `src/tui/glyphs.ts` exporting Unicode and
      ASCII glyph sets and `pickGlyphSet(env) → "unicode" |
      "ascii"` (checks `LANG`, `LC_ALL`, `LC_CTYPE` for
      `UTF-8`/`utf8`).
- [x] 4.2 Unit-test `pickGlyphSet` with a stubbed env: UTF-8
      envs → unicode; `C` / `POSIX` envs → ascii.
- [x] 4.3 Create `src/tui/spinner.tsx` as a small ink component
      that rotates through Braille frames (or ASCII fallback)
      driven by a `tick` prop.

## 5. Ink components

- [x] 5.1 Create `src/tui/header.tsx` rendering the top bar
      (`minifac · brief: <change|(brief-less)> · factory:
      <name> · <current node>`).
- [x] 5.2 Create `src/tui/status-pane.tsx` rendering one row
      per node id with glyph + id + `(n)` iteration suffix +
      selection indicator.
- [x] 5.3 Create `src/tui/log-pane.tsx` rendering the selected
      `(node, iteration)` pair's events through
      `event-rendering`; supports `toggle-details` on the
      highlighted line.
- [x] 5.4 Create `src/tui/hotkeys.tsx` rendering the bottom
      hint bar (advertises `m merge` only when applicable) and
      capturing input via `useInput` to dispatch reducer
      events.
- [x] 5.5 Create `src/tui/app.tsx` wiring `<RunApp>` (header +
      panes + hotkeys + overlays). Detect terminal size and
      switch to the single-pane fallback below 80×24.
- [x] 5.6 Create `src/tui/help-overlay.tsx` listing every
      hotkey and the single-pane caveat.
- [x] 5.7 Add `src/tui/merge-overlay.tsx` rendering captured
      stdout/stderr from the inline `minifac merge` invocation
      with a "press any key to dismiss" footer.

## 6. Renderer adapter and run-controller plumbing

- [x] 6.1 Create `src/tui/renderer.ts` exporting
      `createInkRunRenderer({ brief, factory, store, ... }) →
      { onEvent(entry), waitForExit() → Promise<{exitCode,
      action: "quit" | "raw-switch" | "merge"}>, requestQuit()
      }`. The renderer owns the ink `render()` instance.
- [x] 6.2 The renderer's `onEvent` dispatches each
      `NodeEventEntry` into `runReducer` and triggers a
      re-render.
- [x] 6.3 The `r` hotkey unmounts ink and resolves
      `waitForExit()` with `action: "raw-switch"` so the CLI
      can rewire the run controller's callback to the raw
      formatter.
- [x] 6.4 The `q` hotkey on a mid-run state shows the
      confirmation prompt; on confirm, calls `requestQuit()`
      which signals the executor child and resolves the run
      promise with `{status: "failed", reason: "user_quit"}`.
- [x] 6.5 The `m` hotkey on a succeeded terminal-status run
      re-enters the CLI router with `["merge", changeOrId]`,
      captures the merge's stdout/stderr into the merge
      overlay, and returns to the TUI.

## 7. CLI integration

- [x] 7.1 In `src/cli.ts` (or `src/cli/run.ts`), define
      `pickOutputMode(argv, io) → "raw" | "tui"` per the
      run-cli "Event output format" precedence rules
      (`--raw` → raw; `--tui` → TUI; else `isTTY` → TUI; else
      → raw).
- [x] 7.2 Add `--raw` and `--tui` flag parsing; supplying
      both SHALL exit `1` with a flag-conflict stderr message
      before any run starts.
- [x] 7.3 In raw mode, keep today's `onEvent` formatter
      unchanged.
- [x] 7.4 In TUI mode, construct an `InkRunRenderer` and wire
      its `onEvent` callback into `runFactory()`; await both
      the run promise and the renderer's `waitForExit()`.
- [x] 7.5 Ensure the final `[run] <status> cwd=<path>` stderr
      summary line is emitted after ink unmounts in TUI mode
      (so piped stderr keeps working).
- [x] 7.6 On `action: "raw-switch"` from the renderer, swap
      the run controller's `onEvent` to the raw formatter for
      the remainder of the run.
- [x] 7.7 Plumb `user_quit` through the existing journal /
      failed-runs path so the run row records it as a
      conventional failure with the dedicated reason string.

## 8. CLI snapshot / behavior tests

- [ ] 8.1 Add a test that `process.stdout.isTTY = true` with
      no flags routes to the TUI path (assert the raw
      formatter is NOT called; the renderer is constructed).
- [ ] 8.2 Add a test that `process.stdout.isTTY = false` with
      no flags routes to the raw path (assert today's raw
      output is produced; the renderer is NOT constructed).
- [ ] 8.3 Add tests for `--raw` (forces raw in a TTY) and
      `--tui` (forces TUI in a non-TTY).
- [ ] 8.4 Add a test that `--raw --tui` together exits `1`
      with the flag-conflict stderr message and starts no
      run.
- [ ] 8.5 Add a test that the `[run] <status> cwd=<path>`
      summary line is present on stderr in both modes.

## 9. TUI render snapshot tests

- [ ] 9.1 Using `ink-testing-library`, render `<RunApp>` with
      a synthetic initial `RunState` (all nodes pending) and
      snapshot the frame.
- [ ] 9.2 Snapshot a `RunState` with one node running (spinner
      frame pinned via prop).
- [ ] 9.3 Snapshot a `RunState` with all nodes succeeded.
- [ ] 9.4 Snapshot a `RunState` with one node failed and the
      next iteration retrying.
- [ ] 9.5 Snapshot the terminal `succeeded` state — verify the
      bottom hint includes `m merge` when `branchName` is non-
      null.
- [ ] 9.6 Snapshot the terminal `failed` state — verify the
      bottom hint does NOT include `m merge`.
- [ ] 9.7 Snapshot the sub-80×24 single-pane fallback.
- [ ] 9.8 Snapshot the help overlay (`?`) and the merge
      overlay.

## 10. Hotkey behavior tests

- [ ] 10.1 Test `↓` (and `j`) moves selection and sets
      `followMode = false`.
- [ ] 10.2 Test `Enter` sets `followMode = true` and snaps to
      the currently-running node.
- [ ] 10.3 Test `<` / `>` cycle through prior iterations for a
      cycling node.
- [ ] 10.4 Test `d` toggles details on the highlighted log
      line.
- [ ] 10.5 Test `r` unmounts ink and resolves the renderer's
      `waitForExit()` with `action: "raw-switch"`.
- [ ] 10.6 Test `q` mid-run shows the confirmation prompt; on
      `y` the renderer requests quit and the run row records
      `user_quit`.
- [ ] 10.7 Test `q` on a terminal-status run exits without a
      prompt.
- [ ] 10.8 Test `m` on a succeeded run with a non-null
      `branchName` invokes the merge action and renders the
      overlay; `m` is a no-op on a succeeded run with null
      `branchName` and on any failed run.
- [ ] 10.9 Test `?` toggles the help overlay.

## 11. Documentation

- [ ] 11.1 Update `docs/concepts/Run.md` to mention the TUI is
      the default in a TTY and `--raw` is the escape hatch.
- [ ] 11.2 Create `docs/concepts/Run-TUI.md` describing the
      layout, hotkeys, log-rendering rules, and the sub-80×24
      fallback.
- [ ] 11.3 Update `README.md` quickstart to call out `--raw`
      for scripts / CI.
- [ ] 11.4 Update `examples/sdd.md` quickstart with the same
      callout.

## 12. Acceptance

- [ ] 12.1 `minifac run <brief>` in a TTY shows the TUI.
- [ ] 12.2 `minifac run <brief> > log` (non-TTY) falls back
      to raw with no behavior change vs today.
- [ ] 12.3 `--raw` and `--tui` overrides work in both
      directions.
- [ ] 12.4 All existing tests still pass (357+ baseline).
- [ ] 12.5 `npm run build` is clean.
- [ ] 12.6 `openspec validate run-tui` exits `0`.
