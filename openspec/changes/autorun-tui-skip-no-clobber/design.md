## Context

The autorun scheduler re-evaluates every known brief on every
poll cycle and emits an `AutorunEvent` for each decision —
including decisions that simply re-affirm a brief's existing
state. The raw and JSON consumers want to see every decision
(it's how the operator confirms the scheduler is alive and
making the right calls). The TUI's brief-list reducer, however,
is trying to maintain *display state* — a brief's most recent
real status transition. Treating every `skipped` event as a
status transition is wrong for the TUI even though it's right
for the structured-logging consumers.

The bug surfaces most visibly on `started → skipped(in-flight)`
because the spinner-vs-static glyph swap is conspicuous, but the
same overwrite happens on `succeeded → skipped(activity-
succeeded)` and `failed → skipped(activity-failed)`. Those are
quieter because the glyph happens to swap from `●` to `↷`
without animation, but the wrong skip reason still bleeds
through to the row suffix.

The existing spec defines forward transitions out of `skipped`
(`skipped → started → completed` clears `skipReason`) but is
silent on the reverse: what should happen when `skipped`
arrives for a row whose status is already `running` /
`succeeded` / `failed`. Closing the silence is the entire job.

## Goals / Non-Goals

**Goals:**

- A brief that transitions `queued → running` does NOT flip back
  to `skipped` on a subsequent poll cycle's `skipped` event
  (with reason `in-flight` or `activity-running`). Its `status`
  stays `running`; its `skipReason` stays undefined; the spinner
  keeps animating.
- A brief that has settled into `succeeded` or `failed` does NOT
  have its status overwritten or a `skipReason` introduced when
  a later `skipped` event arrives (with reason
  `activity-succeeded` or `activity-failed`).
- A brief whose status is `queued` (or already `skipped`) still
  transitions to `skipped` with the new reason on a `skipped`
  event — no regression in the existing semantics.
- The autorun-tui spec documents the no-clobber rule explicitly
  so a future reducer refactor cannot silently re-introduce the
  downgrade.

**Non-Goals:**

- Suppressing the noisy `skipped` events at the scheduler
  level. Raw and JSON consumers still want every scheduling
  decision; this is purely a brief-list reducer fix.
- Changing the `dry-run-decision` handler's `skip` path. Its
  semantics are intentionally distinct (dry-run reflects what
  *would* happen, with no underlying live run state to
  protect).
- Glyph-rendering / font-fallback work flagged by the prior
  screenshot (`↷` rendering as a tilde-ish glyph in some
  fonts). That's a font-coverage observation, not a reducer
  bug.
- The autorun-tui-fixes-2 surface (three-column drill-in,
  embedded spinner tick, glyph parity). Independent.

## Decisions

### Drop the event on the floor when the row owns its own state

Three of the five brief statuses (`running`, `succeeded`,
`failed`) are owned by `started` / `completed` events. The
reducer should treat `skipped` as a no-op against rows in those
three states. `queued` and `skipped` are the only states a
`skipped` event can transition out of — those keep their
existing behavior (overwrite with the new reason).

Concretely, the `skipped` case becomes:

```ts
case "skipped":
  return upsertBrief(state, event.change, (row) => {
    if (
      row.status === "running" ||
      row.status === "succeeded" ||
      row.status === "failed"
    ) {
      return row;
    }
    return { ...row, status: "skipped", skipReason: event.reason };
  });
```

Returning the same `row` reference (not a spread) is intentional
— it lets `upsertBrief` continue to short-circuit unchanged rows
if it does so today, but the correctness of the fix does not
rely on that optimization.

Rejected alternative: suppress these events at the scheduler
level, or split `AutorunEvent` into "real" and "re-affirmation"
sub-kinds. Rejected because the raw/JSON consumers genuinely
want the per-cycle decisions, and the brief-list reducer is the
right place to interpret events for display purposes — the same
event stream feeds three different consumers with three
different needs.

### Keep `dry-run-decision` as-is

The `dry-run-decision` handler's `skip` path overwrites status
unconditionally too, but in dry-run mode there is no live
running / terminal state to protect — every brief row reflects
the scheduler's hypothetical decision, and re-affirming on a
later poll is the whole point. No change there.

### Spec the row-protection rule on the reducer requirement, not on a new requirement

The existing "Brief-list event reducer" requirement already
spells out the forward-clearing rule (`skipped → started`
clears `skipReason`). The reverse direction is the natural
companion: add the no-clobber paragraph in the same requirement
and a scenario adjacent to the existing `skipped` scenarios.
Splitting it into a new requirement would fragment a single
invariant ("`skipped` is for queued-out transitions only") into
two places.

## Risks / Trade-offs

- **Risk:** A future event stream could legitimately want a
  `skipped` event to take effect against a `running` /
  terminal row (e.g. some "the run was cancelled" reason). The
  current scheduler emits no such reason, but if one were
  added it would need a new event kind or a flag rather than
  reusing `skipped`. The spec scenario should make that
  trade-off legible to a future reader.
- **Trade-off:** The brief-list and the structured log will
  now show different things on a poll cycle that re-affirms an
  existing state — the log says "skipped (in-flight)" while
  the brief-list says "running". That divergence is the point
  of this change; the brief-list is a display surface, not a
  literal event mirror.

## Migration Plan

No migrations. This is a one-line reducer fix plus a spec
scenario. After the change lands, the existing
`skipped → started → completed` tests still pass (the forward-
clearing path is untouched). Two new tests cover the new
no-clobber rule.

## Open Questions

None — the affected surface is narrow and the fix is
mechanically constrained.
