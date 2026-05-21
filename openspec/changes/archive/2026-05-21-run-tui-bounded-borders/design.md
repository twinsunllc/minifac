## Context

The TUI shipped in archived change `run-tui` (binding
decision [[0021-Run-TUI]]) renders into ink's default
full-viewport surface. In practice two felt issues showed
up immediately:

1. **Overdraw / flicker.** ink reads stdout rows and tries
   to redraw into that surface, but the actual visible
   region in the user's terminal is smaller (scrollback
   + prompt + history are above), so on high-frequency log
   appends the rendered frame "grows past" the visible
   window. The result is a rolling redraw on every event.
2. **Weak zoning.** The four regions (header, status pane,
   log pane, hotkey bar) sit flat on the terminal with no
   structural separator. The seam between panes is carried
   only by spacing and color, which is too quiet for the
   pane density.

The current layout structure (`src/tui/app.tsx`):

```tsx
<Box flexDirection="column">
  <Header />
  {compact ? <LogPane prefix=… /> : (
    <Box>
      <Box width={24}><StatusPane /></Box>
      <Box flexGrow={1}><LogPane /></Box>
    </Box>
  )}
  <HotkeyBar />
  …overlays…
</Box>
```

— no outer height, no borders, no divider.

Decision `0022-Run-TUI-Bounded-Borders` (named in the brief)
pins three calls:

- bounded outer height = `floor(rows / 2)` clamped to a
  minimum
- one bordered Box per major zone (header, body, hotkey
  bar), stacked vertically
- vertical rule between status and log panes inside the
  body; compact mode keeps the bordered shape with a single
  log pane in the body

## Goals / Non-Goals

**Goals:**

- The outer TUI Box has an explicit `height` =
  `max(MIN_TUI_ROWS, floor(terminalRows / 2))` so ink stops
  growing past the visible window.
- Each major zone renders inside a single bordered Box;
  the body's status and log panes are visually separated
  by a vertical rule.
- The sub-80×24 compact fallback keeps working: header +
  hotkey bar bordered above and below, a single bordered
  body containing the log pane.
- No flicker / overdraw on a long run (manual smoke).
- All existing reducer, hotkey, and event-rendering tests
  remain green; layout snapshots are updated.

**Non-Goals:**

- Resizing / split-pane drag handles.
- User-configurable height (e.g. `--tui-height`). Defer
  until someone asks.
- Theming beyond the existing UTF-8 / ASCII fallback.
- Anything touching the event reducer, hotkey contract,
  or log rendering rules.

## Decisions

### Decision: Bounded outer height = `floor(rows / 2)`

The outer `<Box flexDirection="column">` in `src/tui/app.tsx`
gets an explicit `height={tuiRows}` where:

```ts
const fullRows = rows ?? stdoutHook.stdout?.rows ?? 24;
const tuiRows = Math.max(MIN_TUI_ROWS, Math.floor(fullRows / 2));
```

`MIN_TUI_ROWS` equals today's `MIN_ROWS` (24) at the normal
layout, and degrades alongside the existing compact-mode
threshold (sub-80×24) so the TUI still has enough rows to
render even on small surfaces.

**Why half-height:**

- The TUI is the bottom of the terminal; everything above
  remains the user's normal scrollback / history. The TUI
  doesn't claim the whole viewport.
- ink stops growing past the bounded surface — the felt
  flicker disappears as a consequence of giving ink a
  fixed surface to draw into.
- No new flag, no user config. The behavior is automatic.

**Why not full-height with a bigger min:** the felt cost
is the rolling overdraw; "use the whole terminal" was the
shape that caused it.

**Why not user-configurable:** YAGNI until someone asks.

### Decision: One bordered Box per major zone

Header, body, and hotkey bar each render inside a single
`<Box borderStyle="round">` (or `"single"` — whichever ink
renders without seam artifacts in our default font). Inside
each border, `paddingX={1}` keeps content off the line.

Body remains a flex row, status pane on the left
(`width={24}` as today), log pane on the right (flex-grow).

**Why one border per zone (not one border around
everything):** the felt issue is the missing seam between
zones. Three nested borders gives the eye exactly the seam
it was hunting for. A single outer border with internal
spacing still leaves the seam invisible.

**Why borderStyle round/single (not double, ascii, etc.):**
both render cleanly in ink with a single character of
width; double-borders read busy at TUI density; ASCII
fallback can be revisited only if a terminal in the wild
mis-renders the chosen style.

### Decision: Vertical rule between status and log

Inside the body's bordered Box, the status and log panes
are separated by a 1-column-wide divider that spans the
full body height. Two viable implementations:

- A `<Text>`-of-`│` rendered repeatedly per body row.
- A `<Box borderStyle="single" borderTop={false}
   borderBottom={false} borderRight={false} />` between
  the two panes.

We pick whichever renders without seam artifacts against
the surrounding body border in ink's default rendering
mode. The visual contract is the same either way: a
clear vertical separator inside the body.

**Why a rule and not just a border-divided pair of bordered
boxes:** the body border already carries the outer seam.
A second internal border would double-line and look noisy.
A 1-column rule reads as "two zones, one body."

### Decision: Compact mode keeps the bordered shape

The sub-80×24 fallback today: hide the status pane, prefix
the active node into the log pane header line. That
behavior is preserved; the body just renders a single
bordered Box containing the (prefixed) log pane. Header
and hotkey bar remain bordered zones above and below.

**Why preserve the fallback shape:** compact mode is the
only path that worked smoothly on small surfaces; the
border + bound combine well with it. Don't redesign
compact behavior in a layout change.

### Decision: Body height is derived, not configured

The body's `height` is the outer `tuiRows` minus the
header zone (`1 line + top/bottom border = 3 rows`) and
the hotkey bar zone (also 3 rows). The body passes its
derived height down to `<LogPane />` as an explicit
`height` prop so the pane's existing scroll/limit logic
uses the right value. The status pane fills the body
height by virtue of being inside the same flex row.

**Why derive instead of configure:** the heights are a
function of the zone borders and the bounded outer
height; no value the user could provide would help.

## Risks / Trade-offs

- [Risk] `floor(rows / 2)` at very small terminals (sub-24
  rows) clamps to `MIN_TUI_ROWS` and the TUI ends up
  rendering past the visible viewport again. → Mitigation:
  the compact-mode threshold already sits at the size
  where this matters; the help overlay names raw mode (one
  keystroke) as the escape, and the operator can resize.
- [Risk] ink's border characters can produce visible seams
  at junctions between the body border and the internal
  vertical rule, depending on the chosen `borderStyle` and
  the terminal font. → Mitigation: pick the
  border-divider combination that renders without seams in
  the default font; revisit only if a terminal in the
  wild mis-renders.
- [Risk] Existing snapshot tests are sensitive to layout
  width and shape; the change updates several. →
  Mitigation: the reducer / hotkey / event-rendering tests
  are unaffected, so the regression surface is layout-only.
  Add an explicit assertion on outer height across 24, 40,
  60, 120 rows so the bound is tested independently of the
  snapshot.
- [Risk] Manual smoke is the only way to verify "no
  flicker." → Mitigation: snapshot tests assert the
  bounded height; the binding decision is that bounded
  height removes the overdraw. If a follow-up shows
  flicker, the bound is the lever to revisit.

## Migration Plan

This is additive at the user-facing surface — no
migrations, no breaking changes, no new flags. Land in a
single change. Update layout snapshots in the same PR as
the layout edit. The decision-doc pointer in
`docs/decisions/0021-Run-TUI.md` is a one-line addition;
the original decision is preserved.

## Open Questions

- `"round"` vs `"single"` border style. Pin during
  implementation by eye in a real terminal; both satisfy
  the spec.
- Whether the vertical rule uses a `<Text>`-based
  implementation or a no-top/no-bottom `<Box>` border.
  Same answer: pick the one that renders without seams.
  Neither choice affects the spec.
