---
change: autorun-tui-fixes
factory: sdd
---

## Background

The autorun TUI shipped via ADR 0032 / change `autorun-tui`, but
real-world use surfaced two presentation gaps:

1. **Two-column instead of three.** When you drill into a brief, the
   embedded run-view stacks `StatusPane` over `LogPane` vertically
   (`src/tui/autorun-app.tsx:197-204`, `flexDirection: "column"`).
   `RunApp` itself lays them side-by-side (`src/tui/app.tsx:79-95`:
   nodes 24-col + vertical rule + log flexGrow). So the overall TUI
   reads as briefs | (nodes-stacked-over-events), not briefs | nodes |
   events.

2. **Brief-list rows look stuck on their skip reason.** Rows show
   strings like `(blocked)`, `(concurrency)`, `(activity-succeeded)`
   that came from a scheduler `skipped` event, and they don't visibly
   transition when the same brief later gets `started` / `completed`
   on a subsequent poll cycle. The status circle should follow the
   scheduler's view of the brief, and the displayed reason should
   clear (or update) on the next non-skip event.

Both are follow-ups to the original change, not new behavior.

## What to do

- **Three-column drill-in.** When `focus === "run-view"`, render the
  embedded run view using the same body layout `RunApp` uses
  (`StatusPane` width=24 + vertical rule + `LogPane` flexGrow). The
  simplest implementation is probably to embed `RunApp` itself in the
  right pane instead of the custom `RunView` component — that
  guarantees parity (compact-mode collapse, hotkey-handling shape,
  prefix, etc.) and removes the duplicate layout code in
  `autorun-app.tsx`.
- **Brief-list row updates.** Root-cause why rows don't transition
  past their initial skip reason. Likely candidates: the reducer
  retains the skip reason after a subsequent `started` event; the
  status field isn't being reset; or the renderer pulls a stale
  display string. Whatever the cause, ensure a row that goes
  `skipped` → `started` → `completed` cleanly shows running (with
  spinner) → succeeded/failed, with no stale skip-reason text.
- **Tests.**
  - Snapshot the drilled-in frame to verify the three-column shape
    (brief list pane, nodes pane, log pane).
  - Reducer test for the transition sequence: a brief that receives
    `skipped` then `started` then `completed` should end in the
    `succeeded` (or `failed`) state with no residual skip reason.

## Out of scope

- **Orphan-run recovery.** Killed mid-flight runs leave a `running`
  row in runs.db that blocks the next autorun from re-scheduling
  (`computeBriefActivity` returns `activity: "running"` → scheduler
  skips). This is a real gap but a separate brief with its own ADR
  (scheduler / store semantics, not TUI).
- **New autorun features.** No filters, no brief-level cancel/retry,
  no themes. Presentation-only.
- **Changes to the autorun scheduler, lockfile, or runs.db schema.**
  This brief should not touch `src/cli/autorun-scheduler.ts`,
  `src/worktree/lock.ts`, or the storage layer.

## Acceptance criteria

- Drilling into a brief shows a side-by-side nodes pane + log pane
  matching `RunApp`'s body layout — overall TUI reads briefs | nodes
  | events.
- A brief that the scheduler skips then later runs shows its row
  transition past the skip reason: `skipped` → `running` (with
  spinner glyph) → `succeeded`/`failed`. No stale skip-reason text
  after `started`.
- Snapshot test covers the three-column drilled-in frame.
- Reducer test covers the `skipped` → `started` → `completed`
  transition sequence.
- All existing tests still pass; `npm run build` is clean.
