## Why

The autorun TUI shipped via the archived `autorun-tui` change, but two
real-world presentation gaps surfaced once it was driven against actual
briefs:

1. **Drill-in is two columns, not three.** When you press Enter on a
   brief, the embedded run view stacks `StatusPane` over `LogPane`
   (`src/tui/autorun-app.tsx`'s `RunView` uses
   `flexDirection: "column"`), whereas `RunApp` lays them side-by-side
   (24-col nodes pane + vertical rule + log pane flexGrow). The overall
   surface therefore reads as `briefs | (nodes-stacked-over-events)`
   instead of the intended `briefs | nodes | events`.
2. **Brief-list rows stick on their skip reason.** Rows show strings
   like `(blocked)`, `(concurrency)`, or `(activity-succeeded)` that
   arrived in a scheduler `skipped` event, and the visible state does
   not transition cleanly to running / succeeded / failed when the
   same brief is later scheduled. The status circle and suffix should
   follow the scheduler's view of the brief.

Both are follow-ups to the original change, not new behavior. The
`autorun-tui` spec already says the right things at a high level — the
body should render the brief-list pane on the left and the embedded
run view on the right; the reducer should clear `skipReason` when a
skipped brief transitions back to running — but the spec is not
specific enough about the embedded run view's own body shape, and the
existing reducer scenarios do not exercise the full `skipped` →
`started` → `completed` sequence end-to-end.

## What Changes

- **MODIFIED** `autorun-tui` — strengthen the "Autorun TUI layout"
  requirement so the drilled-in body MUST mirror `RunApp`'s body
  layout: a 24-column status / nodes pane on the inside-left of the
  right region, a vertical rule, and the log pane filling the
  remaining width. This eliminates the "two-column embedded view"
  bug by either embedding `RunApp` directly inside the right region
  or replicating its body shape verbatim.
- **MODIFIED** `autorun-tui` — strengthen the "Embedded run-mode view
  reuses run-tui" requirement to spell out that the embedded surface
  SHALL inherit `RunApp`'s body layout (status pane + vertical rule +
  log pane), not just its reducer / glyph table / event-rendering
  rules. The cleanest implementation is to embed `RunApp` itself; the
  spec does not mandate that, but it does mandate the resulting
  visual shape.
- **MODIFIED** `autorun-tui` — strengthen the "Brief-list event
  reducer" requirement with a scenario covering the full
  `skipped` → `started` → `completed` (succeeded or failed) sequence,
  asserting that no residual `skipReason` survives past `started` and
  that the final terminal status is recorded. This makes the
  guarantee testable end-to-end rather than only step-by-step.
- The autorun scheduler, lockfile, run primitive, persistence layer,
  and `AutorunEvent` shape are **unchanged**. This is a
  presentation-only change to the TUI layer.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `autorun-tui`: tighten the body-layout requirement so the
  drilled-in view is side-by-side (briefs | nodes | events); tighten
  the reducer requirement so the full skipped → started → completed
  transition is a covered scenario.

## Impact

- `src/tui/autorun-app.tsx` — replace the custom `RunView` two-column
  composition with either an embedded `<RunApp>` or with the same
  side-by-side `StatusPane` + vertical rule + `LogPane` layout
  `RunApp` uses. Removes the duplicate layout code.
- `src/tui/autorun-reducer.ts` — verify (and, if root-causing reveals
  a bug, fix) that a brief that goes `skipped` → `started` →
  `completed` ends with `status === "succeeded"` / `"failed"` and
  `skipReason === undefined`. The reducer's existing code already
  appears to clear `skipReason` on `started`; the test gap is what
  the change addresses.
- `src/tui/autorun-app.test.tsx` (or equivalent) — snapshot test for
  the drilled-in frame to confirm the three-column shape (brief list
  pane | nodes pane | log pane).
- `src/tui/autorun-reducer.test.ts` — reducer test for the full
  skipped → started → completed sequence.
- No CLI flag changes, no `auto-mode` changes, no `run-tui` changes,
  no schema changes.

### Out of scope

- **Orphan-run recovery.** Killed mid-flight runs leave a `running`
  row in `runs.db` that blocks the next autorun from scheduling
  (`computeBriefActivity` returns `activity: "running"`, scheduler
  emits `skipped` with reason `activity-running`). That is a real
  gap but a separate brief with its own ADR (scheduler / store
  semantics, not TUI presentation).
- **New autorun features.** No filters, no brief-level cancel/retry,
  no themes, no new hotkeys.
- **Changes to the autorun scheduler, lockfile, or `runs.db`
  schema.** This change SHALL NOT touch
  `src/cli/autorun-scheduler.ts`, `src/worktree/lock.ts`, or any
  storage code.
- **Run-mode TUI changes.** The `run-tui` capability is unchanged;
  the fix is one-directional (autorun-tui reuses run-tui's layout).
