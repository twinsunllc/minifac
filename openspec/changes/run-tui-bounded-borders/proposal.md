## Why

Two felt issues with the TUI shipped in
[[0021-Run-TUI]] / archived change `run-tui`:

1. **Flicker / overdraw.** The TUI uses ink's full-viewport
   rendering model and reads terminal dimensions from
   `useStdout().stdout.rows`. The height ink ends up drawing
   into does not match the visible terminal area, so the
   output rolls / flickers on every redraw — especially during
   high-frequency log appends. The render keeps "growing past"
   the visible window.
2. **Weak visual zoning.** All four regions (header, status
   pane, log pane, hotkey bar) sit flat on the terminal with
   no structural separator. The eye has to find the seam
   between panes from spacing and color alone. A simple
   bordered layout would carry that work.

Decision `0022-Run-TUI-Bounded-Borders` pins the answer:
render into a bounded `floor(rows/2)` box at the bottom of
the terminal, with a single bordered Box per major zone and
a vertical rule between the status and log panes.

## What Changes

- **MODIFIED** `run-tui` — the "TUI layout" requirement
  changes shape. The TUI SHALL render into a bounded outer
  Box whose `height` is `floor(terminalRows / 2)` clamped to
  a minimum (`MIN_TUI_ROWS`, equal to today's `MIN_ROWS = 24`
  or smaller when compact mode kicks in). Each of the three
  major zones — header, body (status + log), hotkey bar —
  SHALL render inside a single bordered Box. Inside the body,
  the status and log panes SHALL be visually separated by a
  vertical rule spanning the full body height. The sub-80×24
  compact fallback still collapses the body to a single log
  pane, but inside the same bordered shape.
- No new dependency, no runner change, no event-reducer
  change, no hotkey-contract change.
- Documentation refresh: `docs/concepts/Run-TUI.md` gets the
  new layout sketch; `docs/decisions/0021-Run-TUI.md` gets a
  brief "Updated by 0022" pointer (no rewrite); the
  quickstart in `examples/sdd.md` is refreshed if it shows
  the old layout.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `run-tui`: the "TUI layout" requirement gains a bounded
  outer height and a bordered + vertically-ruled zone shape.
  Existing scenarios about header content, iteration suffix,
  ASCII glyph fallback, and sub-80×24 fallback are preserved;
  new scenarios pin the bounded height and the bordered
  zones.

## Impact

- `src/tui/app.tsx` — compute `tuiRows = max(MIN_TUI_ROWS,
  floor(fullRows / 2))`; apply as `height` to the outer
  `<Box flexDirection="column">`; wrap header, body, and
  hotkey bar each in `<Box borderStyle="round">` (or
  `"single"`); add a vertical-rule divider between status
  and log panes inside the body; subtract border + header +
  hotkey-bar rows when sizing the body so `<LogPane />` gets
  an explicit `height` derived from the bounded surface.
- `src/tui/app.test.tsx` — update existing snapshots to
  reflect the bordered + bounded shape; add a regression
  test that the outer Box's `height` prop is
  `max(MIN_TUI_ROWS, floor(rows / 2))` at representative
  terminal sizes (24, 40, 60, 120 rows). Reducer, hotkey,
  and event-rendering tests stay unchanged.
- `docs/concepts/Run-TUI.md` — replace the layout sketch
  with the new bordered + half-height shape; note the
  bounded-height rationale in one sentence.
- `docs/decisions/0021-Run-TUI.md` — add a one-line
  "Updated by [[0022-Run-TUI-Bounded-Borders]]" pointer;
  do not rewrite the original.
- `examples/sdd.md` quickstart — refresh the layout
  snippet only if it shows the old shape.

### Out of scope

- Resizing / split-pane drag handles
- User-configurable height (e.g. `--tui-height`) — defer
  until someone asks
- Theming beyond the existing UTF-8 / ASCII fallback
- Anything touching the event reducer, hotkey contract, or
  log rendering rules
