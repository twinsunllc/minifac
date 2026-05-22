## Context

The `autorun-tui` capability shipped via the archived 2026-05-22
change. Its body is supposed to be three columns: the brief-list pane
on the left, then the embedded run view (which is itself two columns:
nodes pane + log pane). In `RunApp` the run view's body looks like:

```
┌─ body ────────────────────────────────────────┐
│ <StatusPane w=24>  │  <LogPane flexGrow=1>    │
└────────────────────────────────────────────────┘
```

The autorun TUI was supposed to embed that same body shape on the
right of its own body. Instead `src/tui/autorun-app.tsx`'s `RunView`
stacks the two vertically:

```ts
function RunView({ runState, glyphs }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <StatusPane state={runState} glyphs={glyphs} />
      <LogPane state={runState} />
    </Box>
  );
}
```

So the user sees `briefs | (nodes-stacked-over-events)`, not
`briefs | nodes | events`.

The second bug is reducer-adjacent: rows show stale skip-reason
strings (`(blocked)`, `(concurrency)`, `(activity-succeeded)`) even
after a later poll cycle should have moved them past `skipped`. The
reducer already clears `skipReason` on `started`/`completed`, and
`src/tui/brief-list-pane.tsx`'s `suffixFor` only shows the reason
while `status === "skipped"`. So the existing pure-reducer
behavior **looks** correct on paper. The change owns root-causing
why operators still observe stuck rows — the failure could be
upstream (scheduler emits another `skipped` immediately after the
first non-skip event because `runs.db` still says `running` from a
killed run), in the renderer (event ordering, stale closure), or in
the test coverage (no end-to-end test covers `skipped → started →
completed`).

## Goals / Non-Goals

**Goals:**

- Drilled-in body reads `briefs | nodes | events` — three visible
  columns, with `LogPane` getting the bulk of the width and
  `StatusPane` pinned to 24 columns.
- A brief that goes through `skipped` → `started` → `completed`
  visibly transitions through running (spinner glyph, yellow) and
  ends on `succeeded` (green `●`) or `failed` (red `●`) with no
  parenthetical skip-reason suffix.
- Snapshot test pins the three-column drilled-in frame so the
  layout regression cannot recur silently.
- Reducer test pins the full skipped → started → completed
  transition end-to-end.
- All existing tests still pass; `npm run build` is clean.

**Non-Goals:**

- Adding orphan-run recovery to the scheduler — that's a separate
  brief (`autorun-orphan-recovery`).
- Touching the autorun scheduler, lockfile, runs.db schema, or any
  CLI flag.
- Adding new TUI features (filters, brief-level controls, themes).

## Decisions

### Embed `RunApp` directly vs. replicate its body

The brief recommends embedding `RunApp` itself in the right region
because that guarantees parity with run-mode (compact-mode collapse,
hotkey-handling shape, prefix derivation, glyph table, etc.) and
removes duplicate layout code from `autorun-app.tsx`.

**Decision:** embed `<RunApp>` (with `inputEnabled=false`, since the
autorun TUI is the host that owns input) inside the right region,
delegating the entire run-view body shape to run-mode. The
autorun TUI's outer Box continues to own the header / body / hotkey
zones; the embedded `RunApp`'s own outer chrome (its header / hotkey
bar) is suppressed by replacing it with just the body composition
exported from `app.tsx`, OR by accepting the nested chrome as the
cost of parity — to be decided in implementation. The spec only
mandates the **resulting layout shape**, not which of these two
implementations gets used.

A safer middle ground: extract `RunApp`'s body composition (the JSX
inside the body `<Box>`) into a `RunBody` component that both
`RunApp` and `AutorunApp` use. That avoids nested headers / hotkey
bars and removes layout duplication. This is the recommended
implementation path; it's an internal refactor that doesn't change
either capability's spec text beyond what's already proposed.

### Reducer transition coverage

The existing reducer test covers `skipped → started` (clears
`skipReason`, sets `status: "running"`). It does not cover the
follow-up `completed` step. We add one scenario that walks
`skipped` → `started` → `completed (succeeded)` and asserts the
terminal `status === "succeeded"` and `skipReason === undefined`. A
sibling case for `completed (failed)` is covered by the existing
"completed status=failed sets the brief failed" scenario plus the
new "skipReason cleared by `started`" guarantee.

If root-causing during implementation reveals that the reducer is
actually correct but the bug is in the renderer (e.g. a stale React
closure feeding `setState` with the previous state), the fix lands in
`autorun-renderer.tsx` rather than the reducer. The spec scenario is
written at the reducer level because the reducer is the testable
surface; the renderer just has to feed events into it. Either way,
the assertion at the end (no residual skip-reason after `started`) is
what the spec pins.

### Root-cause finding for the "stuck row" symptom

Walking the three suspects from `tasks.md` task 2.1:

1. **Renderer stale closure** — `src/tui/autorun-renderer.tsx`'s
   `useEffect` that builds the bridge has no dependency array, so it
   re-binds every render; `onEvent` / `onRunEvent` use functional
   `setState((prev) => …)`. No stale state path. Ruled out.
2. **Reducer key-retention bug** — `applyAutorunEvent` for `started`
   and `completed` explicitly writes `skipReason: undefined` over the
   spread `...row`. The new sequence test from task 2.3 confirms the
   final row has `skipReason === undefined`. Ruled out.
3. **Scheduler re-emits `skipped`** — confirmed: when an autorun run is
   killed mid-flight, `runs.db` keeps a `status='running'` row.
   `computeBriefActivity` reads it and returns `activity: 'running'`,
   so the scheduler emits `skipped` with reason `activity-running` on
   every subsequent poll. The TUI is rendering this correctly; the
   row is "stuck" because the scheduler keeps stamping it `skipped`.

The TUI presentation is correct; the bug is upstream. The fix lives
in the scheduler / store and is filed as the
`autorun-orphan-recovery` brief (`inputs/autorun-orphan-recovery.md`).
No scheduler change lands in this PR.

### Snapshot test

The snapshot covers the drilled-in frame at a normal terminal size
(e.g. 100 columns × 30 rows) with at least one brief and at least one
node, `focus === "run-view"`. The snapshot must clearly show three
distinct vertical regions in the body — the brief-list pane, the
status / nodes pane, and the log pane. We use ink-testing-library
(already used elsewhere in `src/tui/`) for the test.

## Risks / Trade-offs

- Embedding `RunApp` wholesale would nest a header / hotkey bar
  inside the autorun TUI's own header / hotkey bar. Extracting a
  shared `RunBody` component avoids that but adds one new module.
  The trade-off lands on the side of cleaner output.
- If root-causing the stuck-row bug surfaces a scheduler-side issue
  (orphan runs from killed processes), the orphan-recovery brief is
  the right place to fix it; the TUI change here makes the
  presentation correct under correct scheduler behavior.

## Migration Plan

None — internal refactor + bug fix. The capability surface is
unchanged from the consumer's perspective; the only observable
difference is that the drilled-in body is now three columns and that
rows transition past their initial skip reason.
