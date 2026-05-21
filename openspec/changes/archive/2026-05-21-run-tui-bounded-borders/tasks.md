## 1. Bound the outer height

- [x] 1.1 Define `MIN_TUI_ROWS` in `src/tui/app.tsx` equal to today's normal-mode `MIN_ROWS` (24), with the same compact-mode degradation behavior as the existing layout.
- [x] 1.2 In `RunApp`, compute `tuiRows = Math.max(MIN_TUI_ROWS, Math.floor(fullRows / 2))` from `rows ?? stdoutHook.stdout?.rows ?? 24`.
- [x] 1.3 Apply `height={tuiRows}` to the outer `<Box flexDirection="column">`.
- [x] 1.4 Subtract the header zone (1 content row + top/bottom border = 3 rows) and the hotkey bar zone (3 rows) from `tuiRows` to derive the body height; pass that derived height to `<LogPane />` as an explicit `height` prop.

## 2. Add bordered zones

- [x] 2.1 Wrap the header in a single `<Box borderStyle="round" paddingX={1}>` (or `"single"` — pick whichever ink renders cleanly in the default font).
- [x] 2.2 Wrap the body (status pane + log pane row, or single log pane in compact mode) in a single `<Box borderStyle="round" paddingX={1}>` (same style as header).
- [x] 2.3 Wrap the hotkey bar in a single `<Box borderStyle="round" paddingX={1}>` (same style).

## 3. Vertical rule between body panes

- [x] 3.1 Inside the body's bordered Box (normal-mode path), render the status pane (`width={24}`) on the left, the log pane (`flexGrow={1}`) on the right, and a 1-column-wide vertical rule between them spanning the full body height.
- [x] 3.2 Choose the rule implementation that renders without seams against the body border: `<Text>`-of-`│` per body row OR `<Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} />`. Whichever ships, document the choice inline if it's non-obvious.

## 4. Compact-mode behavior preserved

- [x] 4.1 In compact mode (`cols < MIN_COLS || rws < MIN_ROWS`), render the body's bordered Box containing only the log pane (no status pane, no vertical rule); the active-node prefix on the log header line is unchanged from today.
- [x] 4.2 The header and hotkey bar bordered zones still render above and below in compact mode.

## 5. Tests

- [x] 5.1 Update existing `src/tui/app.test.tsx` snapshot tests to reflect the new bordered + bounded shape; reducer, hotkey, and event-rendering tests are unaffected.
- [x] 5.2 Add a regression test that asserts the outer rendered Box's `height` prop equals `Math.max(MIN_TUI_ROWS, Math.floor(rows / 2))` at terminal sizes of 24, 40, 60, and 120 rows.
- [x] 5.3 Add (or extend) a test asserting that in normal mode the body renders three children — status pane, vertical rule, log pane — and that in compact mode the body renders only the log pane.
- [x] 5.4 Verify hotkey, reducer, and event-rendering tests still pass without modification.

## 6. Docs

- [x] 6.1 Update `docs/concepts/Run-TUI.md`: replace the layout sketch with the new bordered + half-height shape and add a one-sentence note about the bounded-height rationale.
- [x] 6.2 Add a single "Updated by [[0022-Run-TUI-Bounded-Borders]]" pointer to `docs/decisions/0021-Run-TUI.md` (do not rewrite the original).
- [x] 6.3 Refresh the layout snippet in `examples/sdd.md` quickstart only if it shows the old shape.

## 7. Verify

- [x] 7.1 Manual smoke: `minifac run <some-brief>` shows the bounded TUI at the bottom half of the terminal with three bordered zones and a vertical rule in the body; no flicker / overdraw during a long log-emitting run.
- [x] 7.2 Build clean, biome clean, all existing tests pass.
