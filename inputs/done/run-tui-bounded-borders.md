---
change: run-tui-bounded-borders
factory: sdd
base_branch: main
---

## Background

Two felt issues with the TUI as shipped in [[0021-Run-TUI]]:

1. **Flicker / overdraw.** The TUI uses ink's full-viewport
   rendering model and reads terminal dimensions from
   `useStdout().stdout.rows`. In practice the height ink ends up
   drawing into doesn't match the visible terminal area, so the
   output rolls / flickers on every redraw — especially during
   high-frequency log appends. The render keeps "growing past"
   the visible window.
2. **Weak visual zoning.** All four regions (header, status
   pane, log pane, hotkey bar) sit flat on the terminal with no
   structural separator. The eye has to find the seam between
   panes from spacing and color alone. A simple bordered layout
   would carry that work.

The binding decision is captured at
`docs/decisions/0022-Run-TUI-Bounded-Borders.md`. Read it first.
Key design calls already locked there:

- TUI renders into a **bounded box** of `floor(rows/2)` rows
  (clamped to a sensible minimum); content above remains visible
  in the scrollback as the user's normal terminal history. The
  TUI never tries to claim the full viewport.
- Each of the three major zones — **header**, **body** (status
  pane + log pane side-by-side), **hotkey bar** — gets a single
  bordered box, stacked top-to-bottom. Inside the body, the
  status and log panes are separated by a **vertical rule**
  spanning the full body height.
- Compact mode (sub-80×24) keeps the bordered shape but collapses
  the body to a single log pane, as today.

## What to do

### 1. Bound the height

- In `src/tui/app.tsx`, compute an effective height as
  `Math.max(MIN_TUI_ROWS, Math.floor(rws / 2))` where `MIN_TUI_ROWS`
  is `MIN_ROWS` (24) or smaller if compact mode kicks in. Sketch:

      const fullRows = rows ?? stdoutHook.stdout?.rows ?? 24;
      const tuiRows = Math.max(MIN_TUI_ROWS, Math.floor(fullRows / 2));

- Apply that height to the outer `<Box flexDirection="column">`
  via `height={tuiRows}`. The TUI now occupies the bottom half
  of the terminal; ink draws into that bounded surface and stops
  growing.
- Subtract the header (1 line + border = 3) and hotkey bar
  (1 line + border = 3) from the body height when sizing the
  status + log panes. Pass an explicit `height` down to
  `<LogPane />` so its existing scroll/limit logic uses the
  right value.
- Verify by manual smoke test (`minifac run <some-brief>`):
  redraws should be stable, no rolling / no overdraw.

### 2. Add borders

- Wrap each of the three zones in `<Box borderStyle="round">`
  (or `"single"` — pick what reads cleanly). One bordered Box
  per zone, with the zones stacked vertically. Body remains a
  flex row with status + log inside.
- Inside the body, separate status and log with a vertical-rule
  divider component (1-column-wide Box containing repeated `│`
  characters via `<Text>` per body row, or
  `<Box borderStyle="single" borderTop={false} borderBottom={false}
   borderRight={false} />` — whichever ink renders without seams
  against the surrounding body border). The divider spans the
  full body height.
- Status pane keeps its existing fixed-ish width (24).
- Use `paddingX={1}` inside each border so content does not
  butt up against the line.

### 3. Compact-mode behavior

- The sub-80×24 fallback (today: hide status pane, prefix the
  active node into the log pane header line) keeps working,
  but renders inside a single bordered box covering the
  bounded-height region. Header + hotkey bar remain bordered
  zones above and below.

### 4. Doc & ASCII-art updates

- `docs/concepts/Run-TUI.md` — replace the layout sketch with
  the new bordered + half-height shape. Note the bounded-height
  rationale in a sentence.
- `docs/decisions/0021-Run-TUI.md` — add a brief "Updated by"
  pointer to 0022; do not rewrite the original decision.
- `examples/sdd.md` quickstart — no code change, but if it
  showed the old layout, refresh that snippet.

### 5. Tests

- `src/tui/app.test.tsx` — update existing snapshot tests to
  reflect the new bordered + bounded shape. The reducer tests
  are unaffected.
- Add a regression test: at typical terminal sizes (24, 40, 60,
  120 rows) the outer rendered Box's `height` prop is
  `floor(rows/2)` floored at `MIN_TUI_ROWS`.
- Hotkey, reducer, and event-rendering tests stay green.

### 6. Specs

- `run-cli`: MODIFIED requirement covering the bounded-height
  layout and the bordered zones. Copy the entire requirement
  block; do not partial-paste.
- If the prior `run-tui` capability lived in a dedicated spec,
  MODIFY that one instead.

## Out of scope

- Resizing / split-pane drag handles
- User-configurable height (e.g. `--tui-height`) — defer until
  someone asks
- Theming beyond the existing UTF-8 / ASCII fallback
- Anything touching the event reducer or render rules

## Acceptance criteria

- Outer TUI Box has `height = floor(terminalRows/2)` clamped to
  `MIN_TUI_ROWS`
- Header, body (status+log), and hotkey bar each render inside
  a single bordered Box
- Status and log panes are visually separated inside the body
- Compact (<80×24) mode still renders a single log pane inside
  the bordered shape, header + hotkey bar still present
- No flicker / overdraw on a long run (manual smoke)
- Snapshot tests updated; reducer / hotkey / event-rendering
  tests unchanged and passing
- Build clean; biome clean; all existing tests pass
