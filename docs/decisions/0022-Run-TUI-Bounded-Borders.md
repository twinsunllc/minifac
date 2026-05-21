---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0022: Bounded-height, bordered TUI layout

## Context

The TUI shipped via [[0021-Run-TUI]] renders into ink's default
full-viewport mode and reads terminal dimensions from
`useStdout().stdout.rows`. Two felt problems emerged in practice:

1. **Flicker / overdraw.** Ink's rendered height frequently
   exceeds the visible terminal area, so high-frequency updates
   (every spinner tick + every log line append) cause the output
   to scroll and redraw, producing a visible rolling effect. The
   issue is most pronounced during the `apply` node, which can
   emit hundreds of events in seconds.

2. **Weak visual zoning.** The four flat regions (header, status
   pane, log pane, hotkey bar) sit on the terminal with no
   structural separator. The eye locates the seam from spacing
   and color alone. A bordered shape would carry that work
   without requiring users to learn the layout.

Neither problem is a runner correctness issue — they're presentation
quality bugs. But the TUI is the surface most users will form
their first impression of minifac on, so they matter.

## Decision

The TUI renders into a **bounded-height bordered layout**:

- The outer Box has `height = floor(terminalRows / 2)`, clamped
  to `MIN_TUI_ROWS` (currently 24).
- Three zones — **header**, **body** (status + log side-by-side),
  **hotkey bar** — each render inside a single bordered Box
  stacked top-to-bottom.
- Inside the body, status and log are separated by a vertical
  rule that spans the full body height.
- Compact mode (sub-80×24) keeps the bordered shape and
  collapses the body to a single log pane, prefixed with the
  current node's status (as today).

The bounded height means the TUI occupies the bottom half of
the terminal. Output that arrived before `minifac run` started
remains visible above as normal scrollback. Ink draws into a
bounded surface and stops growing — the rolling / flicker goes
away.

### Layout

```
┌────────────────────────────────────────────────────────────────┐
│ minifac · brief: run-scoped-branches · factory: sdd · verify   │
└────────────────────────────────────────────────────────────────┘
┌──────────────────────┬─────────────────────────────────────────┐
│ ● propose            │ [verify · iter 1 · running]             │
│ ● apply              │                                         │
│ ◔ verify       (1)   │  → running npm test                     │
│ ○ archive            │  ✓ 357 tests passed in 2.33s            │
│                      │  → running npm run build                │
│                      │  ⠋ ...                                  │
└──────────────────────┴─────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────┐
│ ↑↓ select  enter follow  r raw  d details  q quit              │
└────────────────────────────────────────────────────────────────┘
```

Each outer rectangle is its own bordered Box. The body row is a
single bordered Box containing two flex children with an internal
divider.

### Why `floor(rows / 2)`

- A fixed row count (e.g. `20`) would feel cramped on tall
  terminals and clipped on short ones.
- Reading the full terminal height and using it is what produced
  the flicker — ink's view of "rows" is unreliable in practice.
- Halving the terminal height gives the TUI a generous but
  bounded canvas while preserving scrollback context above. Most
  modern terminals run 40+ rows; that leaves the TUI 20+ rows,
  enough for status + log without scrolling for short runs.
- The clamp to `MIN_TUI_ROWS` (24) keeps the experience usable on
  abnormally short terminals — the TUI still expands enough to
  fit the layout; the user just loses some scrollback above.

### Why borders (instead of just spacing)

- Ink renders Unicode box-drawing characters reliably across the
  terminals we already support (we already use them for the
  glyph set).
- Borders give a strong, instantly-readable visual frame without
  requiring the user to learn a custom layout.
- The cost is minimal — three lines of border per zone, no
  meaningful effect on usable content area at 80 cols.

## Consequences

- **Stable rendering.** Bounded height removes the overdraw
  loop. Spinner and log appends paint cleanly.
- **Reduced active area.** The TUI claims the bottom half of
  the terminal. Users with tall terminals get less log surface
  than they would if the TUI claimed everything — but the
  scrollback above retains their previous shell context, which
  is the right trade for one-shot CLI runs.
- **Compact-mode tweak.** The sub-80×24 fallback now renders
  inside borders too. Borders cost 6 rows total (3 zones × 2
  border lines). On a 24-row terminal that leaves 18 content
  rows in the bounded half — tight, but workable. Below that
  the experience degrades gracefully.
- **No event-pipeline impact.** This change is purely
  presentational. The reducer, event-rendering rules, hotkeys,
  and runner remain untouched.
- **Studio reuse stays valid.** [[Studio]] consumes the same
  reducer; presentation differences are expected between the
  CLI and a web surface.

## Alternatives considered

- **Full-viewport with a fix to the height read.** Tried
  exploring this; ink's effective rendered height depends on
  whether we patch console, on terminal scrollback config, and
  on cursor position at launch. Bounded-height sidesteps the
  whole class of issue rather than chasing it.
- **Configurable height (`--tui-height`).** Defer. The first
  question is "does half-height feel right?" not "what knob do
  we expose?". Add later if anyone asks.
- **Borders only, full-height.** Borders alone don't fix the
  flicker — the rolling overdraw was the louder problem.
- **One single outer border with internal dividers.** Considered.
  Three separate boxes paint cleaner in practice in ink — internal
  rule characters between flex children sometimes leave seams
  that look unintentional. Three stacked bordered boxes feels
  more deliberate.
- **Render the TUI into the alternate screen buffer.** Genuine
  full-screen would solve the overdraw issue and would be the
  "correct" answer for a stable interactive surface. Rejected
  for now because (a) it interferes with scrollback access
  during the run and (b) ink doesn't switch buffers by default
  and turning it on is a separate, larger commit. Could revisit.

## Open questions

- Border style: `"round"` vs `"single"`. Probably `"round"` —
  matches the merge-overlay style already shipped. Confirm during
  implementation.

## Related

- [[0021-Run-TUI]] — original TUI decision; this one updates
  the layout without changing the event model or hotkey contract
- [[Run-TUI]] — concept doc; updated to reflect the new layout
- [[Roadmap]] — adds `run-tui-bounded-borders` to the queue
