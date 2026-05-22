---
change: autorun-tui-fixes-2
factory: sdd
---

## Background

The first `autorun-tui-fixes` round (merged at `c1dac2c`) was
supposed to give the autorun TUI a true three-column layout
(briefs | nodes | events) when drilled into a brief. It shipped a
shared `RunBody` component in `src/tui/app.tsx` and re-used it from
`src/tui/autorun-app.tsx`, then committed a snapshot test named
"three vertical regions: briefs | nodes | events" — but the layout
in real terminals is still briefs | (nodes-stacked-over-events).

The reason is a one-line mismatch in `src/tui/autorun-app.tsx:238`:

```tsx
<Box flexDirection="column" flexGrow={1}>
  {state.focus === "run-view" && runState ? (
    <RunBody state={runState} glyphs={glyphs} bodyHeight={bodyHeight} compact={false} />
  ) : (
    <EmptyRunHint />
  )}
</Box>
```

`RunBody` is a fragment of three children (`StatusPane`, rule,
`LogPane`) that relies on its parent's flex direction to lay them
out side-by-side. `RunApp` mounts it inside a default-`row` Box and
gets the three-column shape; `AutorunApp` mounts it inside an
explicitly-`column` Box, which forces vertical stacking. The
snapshot was committed showing the bug rather than the intended
shape, so CI happily passed:

```
│   ⠋ alpha                │ ▸ ⠋ propose      │
│ · ⠋ beta                 │   ○ apply        │
│                          │ ▸ thinking…      │
```

While we're in here, the embedded run-state spinner also never
animates. `src/tui/autorun-renderer.tsx:127-134` ticks only the
autorun reducer:

```ts
useEffect(() => {
  const handle = setInterval(() => {
    if (state.briefs.some((b) => b.status === "running")) {
      dispatchAutorun({ kind: "tick" });
    }
  }, 100);
  return () => clearInterval(handle);
}, []);
```

That animates the brief-list spinners on the left, but the run TUI
ticks its own reducer for the per-node spinner, and the autorun
TUI never wires that through. Drill into a running brief and the
glyph next to the active node stays static.

## What to do

- **Three-column layout.** In `src/tui/autorun-app.tsx`, remove the
  explicit `flexDirection="column"` from the body Box that wraps
  `RunBody` (line 238). The Ink default `row` is what `RunBody`
  needs.
- **Spinner ticking for the embedded run.** In
  `src/tui/autorun-renderer.tsx`, extend the existing 100ms tick
  loop to also dispatch a tick into the currently-selected brief's
  `runState` slot when that slot exists and has any node in a
  running-ish status. Use `runReducer` so the run TUI's existing
  tick semantics are preserved verbatim — do not invent a parallel
  spinner clock for the autorun embed.
- **Fix the misleading snapshot.** The existing
  `src/tui/__snapshots__/autorun-app.test.tsx.snap` entry titled
  "three vertical regions: briefs | nodes | events" snapshots
  the buggy two-column shape. Regenerate it from the fixed code
  and verify by eyeball that the snapshot now contains three
  visibly distinct columns separated by vertical rules.
- **Add an explicit assertion** alongside the snapshot that checks
  for the presence of two vertical-rule glyphs in the drilled-in
  body row (one between briefs and nodes, one between nodes and
  log), so this class of regression can't pass review again by
  someone approving a wrong snapshot.
- **Brief-list glyphs and colors match the run-TUI node row.** The
  brief-list pane (`src/tui/brief-list-pane.tsx`) and the run-TUI
  status pane (`src/tui/status-pane.tsx`) should render visually
  identically for the shared states:
  - queued ↔ pending → open circle (`○` / `.`), gray
  - running → animated spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` / `|/-\`), yellow
  - succeeded → filled circle (`●` / `o`), green
  - failed → filled circle (`●` / `!`), red

  Brief-specific `skipped` keeps its own glyph (`↷` / `~`, gray) —
  no analog exists on the node side.

  The current `colorFor` in `brief-list-pane.tsx:13-26` and
  `colorForStatus` in `status-pane.tsx:7-22` already agree on
  colors for the shared states; the running-row branch already
  routes through the shared `<Spinner>`. Audit and confirm there's
  no remaining drift (glyph selection, spacing, marker width,
  color application to the row label vs. glyph) — fix anything
  that does drift.
- **Side-by-side parity test.** Add a test that renders one row at
  each shared status through both `BriefListPane` and the
  per-node rendering used by `StatusPane`, and asserts the glyph
  + color tokens match. The test should fail if anyone later
  tweaks one without the other.

## Out of scope

- Any changes to `RunBody`, `RunApp`, or the run-mode TUI itself.
- Changes to the brief-list reducer or pane.
- New keybinds, new flags, or new event types.
- The orphan-recovery surface (already shipped via
  `autorun-orphan-recovery`).
- The auto-merge surface (separate brief, in flight).

## Acceptance criteria

- In a terminal ≥ 80 cols, with focus = `run-view` and a populated
  `runState`, the drilled-in body shows three visibly distinct
  columns separated by vertical rules: brief list (24 cols) | node
  status pane (24 cols) | log pane (rest).
- The selected node's spinner glyph animates while that node is
  running, matching the behavior of `minifac run`'s TUI in the same
  state.
- The "three vertical regions" snapshot in
  `src/tui/__snapshots__/autorun-app.test.tsx.snap` is regenerated
  and now contains two vertical rules in each body row.
- A new test asserts the two-vertical-rule invariant on the
  drilled-in body, independent of the snapshot.
- Brief-list rows for queued, running, succeeded, and failed
  briefs use the same glyphs and colors as the corresponding
  node-row states in the run-TUI status pane. `skipped` keeps
  its own brief-specific glyph and color.
- A parity test asserts glyph + color equivalence between
  brief-list rows and run-TUI node rows across the four shared
  states; the test fails if one side drifts.
- All existing tests still pass; `npm run build` is clean.
