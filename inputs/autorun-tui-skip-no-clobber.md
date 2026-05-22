---
change: autorun-tui-skip-no-clobber
factory: sdd
---

## Background

The autorun TUI's brief-list reducer
(`src/tui/autorun-reducer.ts:124-129`) unconditionally overwrites
a row's status on every `skipped` event:

```ts
case "skipped":
  return upsertBrief(state, event.change, (row) => ({
    ...row,
    status: "skipped",
    skipReason: event.reason,
  }));
```

The autorun scheduler emits a `skipped` event on **every poll
cycle** for any brief whose state it already knows about — including
briefs that are currently running (`src/cli/autorun-scheduler.ts:109`
emits `{ action: "skip", reason: "in-flight" }` for them) and
briefs whose previous run already succeeded or failed (emitted with
reasons `activity-running`, `activity-succeeded`,
`activity-failed`). These are not real state transitions; they're
the scheduler re-affirming an existing state.

In the brief-list, the consequence is visible immediately: a row
that just got a `started` event (status → `running`, spinner
should animate) flips to `skipped` with reason `in-flight` on the
next poll. The spinner stops, the row's glyph collapses to the
static skipped glyph (`↷`, which falls back to a tilde-ish
character in some fonts), and the brief looks like the scheduler
just skipped it — when in fact it is still in flight.

The user-visible symptom is "the brief list goes to weird tilde
things after the first tick once I drill in" — that's the
running/succeeded rows being clobbered by the next poll cycle's
`skipped` events.

The existing spec
(`openspec/specs/autorun-tui/spec.md`) defines the forward
transitions (`skipped → started → completed` clears the skip
reason) but never specifies the reverse direction — what should
happen when a `skipped` event arrives for a row whose status is
already `running`, `succeeded`, or `failed`. The current
implementation silently downgrades; the spec is silent. This
brief closes that gap.

## What to do

- **Reducer change.** In the `skipped` handler in
  `src/tui/autorun-reducer.ts`, preserve the row when its
  current status is `running`, `succeeded`, or `failed`. Those
  three states are owned by `started` / `completed` events;
  `skipped` only governs transitions out of `queued` (or a
  prior `skipped`). Concretely:

  ```ts
  case "skipped":
    return upsertBrief(state, event.change, (row) => {
      if (row.status === "running" || row.status === "succeeded" || row.status === "failed") {
        return row;
      }
      return { ...row, status: "skipped", skipReason: event.reason };
    });
  ```

- **Spec scenario.** Add a "skipped event does NOT override a
  running/terminal row" scenario to the autorun-tui capability
  spec, formalizing the rule above. Place it adjacent to the
  existing skipped scenarios.

- **Tests.** Add two reducer tests covering the new behavior:
  - `started → skipped(in-flight)` leaves the row `running`
    with no `skipReason`.
  - `started → completed(succeeded) → skipped(activity-succeeded)`
    leaves the row `succeeded` with no `skipReason`. Mirror with
    `completed(failed) → skipped(activity-failed)` to cover the
    failed terminal too.

## Out of scope

- **Suppressing the noisy `skipped` events at the scheduler
  level.** The raw logger and JSON consumers still want to see
  every scheduling decision; this is purely a brief-list
  reducer fix.
- **Changing the `dry-run-decision` handler.** Its `skip` path
  is intentionally distinct (dry-run reflects what *would*
  happen, with no underlying live run state to protect).
- **Glyph-rendering / font-fallback issues** flagged on the
  prior screenshot (the `↷` rendering as a tilde-ish glyph in
  some fonts). That's a font-coverage observation, not a
  reducer bug; this brief doesn't try to address it.
- **The autorun-tui-fixes-2 brief's surface** (three-column
  drill-in, embedded spinner ticks, glyph parity). Independent.

## Acceptance criteria

- A brief that transitions `queued → running` does NOT flip back
  to `skipped` when the next poll cycle's `skipped` (with reason
  `in-flight` / `activity-running`) arrives. Its `status` stays
  `running` and its `skipReason` stays undefined; the spinner
  keeps animating.
- A brief that transitions `running → succeeded` (or `failed`)
  does NOT have its status overwritten or a `skipReason`
  introduced when a later `skipped` event (with reason
  `activity-succeeded` / `activity-failed`) arrives.
- A brief whose status is `queued` or already `skipped` still
  transitions to `skipped` with the new reason on a `skipped`
  event (no regression to the existing semantics).
- The autorun-tui capability spec includes a "skipped event does
  NOT override a running/terminal row" scenario.
- Two new reducer tests assert the new invariant; the existing
  `skipped → started → completed` tests still pass unchanged.
- `npm run build` is clean; all existing tests pass.
