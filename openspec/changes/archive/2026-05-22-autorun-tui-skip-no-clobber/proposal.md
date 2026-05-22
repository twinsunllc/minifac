## Why

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
cycle** for any brief whose state it already knows about —
including briefs that are currently running
(`src/cli/autorun-scheduler.ts:109` emits `{ action: "skip",
reason: "in-flight" }` for them) and briefs whose previous run
already succeeded or failed (emitted with reasons
`activity-running`, `activity-succeeded`, `activity-failed`).
These are not real state transitions; they're the scheduler
re-affirming an existing state.

In the brief-list, the consequence is visible immediately: a row
that just received a `started` event (status → `running`, spinner
animating) flips to `skipped` with reason `in-flight` on the next
poll. The spinner stops, the row's glyph collapses to the static
skipped glyph (`↷`), and the brief looks like the scheduler just
skipped it — when in fact it is still in flight. The same applies
after a run terminates: a `succeeded` / `failed` row gets
overwritten to `skipped (activity-succeeded)` / `skipped
(activity-failed)` on the next poll.

The user-visible symptom is "the brief list goes to weird tilde
things after the first tick once I drill in" — the running /
terminal rows being clobbered by the next poll cycle's `skipped`
events.

The existing autorun-tui spec defines the forward transitions
(`skipped → started → completed` clears the skip reason) but
never specifies what should happen when a `skipped` event arrives
for a row whose status is already `running`, `succeeded`, or
`failed`. The current implementation silently downgrades; the
spec is silent. This change closes that gap.

## What Changes

- **MODIFIED** `autorun-tui` — strengthen the "Brief-list event
  reducer" requirement so that a `skipped` event SHALL NOT
  overwrite a row whose current status is `running`,
  `succeeded`, or `failed`. Those three states are owned by
  `started` / `completed` events; `skipped` only governs
  transitions out of `queued` (or a prior `skipped`). Add a
  scenario asserting the new invariant adjacent to the existing
  skipped scenarios.
- The `dry-run-decision` handler's `skip` path is **unchanged**:
  dry-run reflects what *would* happen, with no underlying live
  run state to protect.
- The autorun scheduler, lockfile, run primitive, persistence
  layer, the raw / JSON consumers of structured logging, and the
  `AutorunEvent` shape are **unchanged**. The scheduler keeps
  emitting `skipped` on every poll; only the brief-list
  reducer's interpretation of those events changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `autorun-tui` — strengthen the "Brief-list event reducer"
  requirement with the no-clobber rule and a new scenario. No
  new capability surface; glyph rendering, layout, hotkey
  contract, embedded run-mode view, and "TUI does not change
  the autorun primitive" requirements are unaffected.
