---
change: node-outputs-nudge
factory: sdd
base_branch: main
depends_on:
  - node-outputs
---

## Background

[[0027-Node-Outputs]] introduces declared required outputs;
missing required outputs override the terminal status to
`failed`. That's the correct contract but wasteful when the
failure is *protocol* (forgot a tool call / forgot a file
write) rather than *substantive* (the work really didn't
land).

The binding decision is at
`docs/decisions/0028-Node-Outputs-Nudge.md`. Read it first.
Key calls already locked:

- One-budget nudge by default (`output_nudge_budget: 1`),
  opt-out via `output_nudge_budget: 0`.
- Nudge sent only when sentinel said `succeeded` but
  required outputs are missing. Sentinel-failed nodes are
  never nudged.
- Runner-emitted events tagged distinctly from model events.

Depends on `node-outputs` having landed.

## What to do

### 1. Schema — `output_nudge_budget`

Extend `src/factory/schema.ts`'s `NodeSchema`:

```typescript
output_nudge_budget: z.number().int().nonnegative().optional().default(1),
```

Default `1`. Per-node override; no factory-level default.

### 2. Detect missing outputs *before* recording terminal

Refactor the post-execution flow in `src/runner/run.ts`:

```
loop:
  wait for `result` event
  parse sentinel
  if sentinel === "failed":
    break (skip outputs check entirely)
  validate declared outputs
  if outputs valid:
    break (record succeeded)
  if budget > 0:
    write nudge to stdin
    decrement budget
    continue (wait for next `result` event)
  break (record failed with missing_required_output)
```

The exact loop shape depends on how the Claude executor's
event consumption is structured today; the key point is the
loop terminates either when outputs are valid, sentinel says
failed, or budget is exhausted.

### 3. Nudge message format

When sending a nudge, the synthetic user message is a
runner-generated string. Construct it from the missing-
outputs list:

```
The following declared required outputs were not produced:

  - findings (type: value): expected at <outputs_dir>/findings.json
  - report  (type: file):   expected at <outputs_dir>/report.md

Please produce these outputs now. After they're written,
emit MINIFAC_STATUS: succeeded (or MINIFAC_STATUS: failed
with a REASON if you cannot produce them).
```

The message is constructed by a helper
(`buildNudgeMessage`) — write tests against the helper, not
against the entire flow.

### 4. Writing to stdin

The Claude CLI in stream-json mode accepts user messages
over stdin as JSON-encoded events. The runner writes the
nudge as a properly framed user-message event, leaves stdin
open, and continues consuming events.

If writing fails (broken pipe, etc.), treat as immediate
failure with reason `missing_required_output` — don't try
to recover.

### 5. Event tagging

Emit two new event kinds via the runner's `onEvent`:

- `system / runner-action` — `"Required outputs missing,
  nudging (budget remaining: 0)..."`
- `user / runner-nudge` — the nudge message itself

Tag both events with the originating `nodeId` and the
current iteration. Persist them through the existing
event pipeline into `runs.db`.

### 6. `NodeResult` field

Optional but recommended: extend `NodeResult` with a
`nudges_used: number` field. Defaults to 0. Increment each
time a nudge is sent. Useful for observability + future
analysis ("which factories nudge a lot?").

### 7. Concept / docs updates

- Update `docs/concepts/Outputs.md` (created by
  `node-outputs`) with a "Nudge recovery" section.
- Update `docs/concepts/Factory.md`'s schema to document
  `output_nudge_budget`.

### 8. Tests

- Default budget (`1`): missing outputs → nudge → model
  fixes → succeeded.
- Default budget (`1`): missing outputs → nudge → model
  still doesn't fix → failed with
  `missing_required_output`.
- Budget `0`: missing outputs → immediate failed, no nudge.
- Sentinel `failed`: no nudge regardless of outputs state.
- `nudges_used` counter accurate.
- Runner-emitted events tagged correctly and persisted.
- Nudge message content matches the helper's output.

### 9. Spec deltas

- `graph-runner` (or `node-outputs` if you folded the
  capability into it): ADD a scenario covering the nudge
  loop.
- MODIFY the existing `missing_required_output` requirement
  from `node-outputs` to note the nudge layer.

## Out of scope

- Customizable nudge messages per factory (factory authors
  don't write their own retry copy in v1).
- Multi-budget defaults (`> 1`) — leave the default at
  `1`. Factories can set higher per-node if they really
  want, but the default is intentional.
- Nudging on sentinel-failed nodes.
- Cross-iteration nudge budget accounting.

## Acceptance criteria

- `output_nudge_budget` field on node schema; default `1`
- Missing required outputs after `succeeded` sentinel →
  nudge → re-validate → final status
- Budget `0` opts out of nudging cleanly
- Runner-emitted nudge events visible in stream + persisted
  to runs.db
- `nudges_used` field on `NodeResult` populated
- All existing tests pass; new tests cover the criteria
- Docs / Factory schema reflect the new field
