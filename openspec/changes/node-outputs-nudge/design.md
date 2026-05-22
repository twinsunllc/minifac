# Design — node-outputs-nudge

Implementation notes for the missing-outputs nudge loop. Reads
on top of `docs/decisions/0028-Node-Outputs-Nudge.md` (the
binding decision) and the `node-outputs` change that established
the validation layer this softens.

## Loop shape

The decision doc fixes the high-level shape; this section pins
it to the runner's existing event-drain pattern.

The runner's post-execution flow in `src/runner/run.ts` today
looks roughly like:

```
dispatch node
drain events from executor.run()  ← stops at `result` event
parse sentinel from drained events
validate outputs
record NodeResult
```

With the nudge loop, the middle two steps grow into a bounded
loop:

```
dispatch node
budget = node.output_nudge_budget ?? 1
nudges_used = 0
loop:
  drain events from executor.run()  ← stops at `result` event
  parse sentinel from drained events
  if sentinel === "failed":
    break (skip outputs validation, per node-outputs)
  validate outputs
  if outputs valid:
    break (record succeeded)
  if budget === 0:
    break (record failed with missing_required_output)
  emit `system / runner-action` event
  emit `user / runner-nudge` event
  write nudge to executor stdin  ← may throw on broken pipe
  budget -= 1
  nudges_used += 1
  continue  ← drains the next turn's events
record NodeResult (status, outputs, nudges_used)
```

The Claude executor's `run()` method today returns an
async-generator that ends when the final `result` event lands.
For the loop above to work, the executor needs to support
"reopening" the drain after a stdin write — i.e. the returned
async iterator is *not* terminal until the runner explicitly
closes stdin or the executor process exits. The decision doc
asserts this is already how stream-json works (`result` is
end-of-turn, not end-of-session); during implementation the
runner SHOULD verify with a manual test that writing a
user-message event after `result` does in fact produce a new
turn's events. If the executor's current implementation closes
stdin or stops draining at `result`, that's a small refactor:
the executor's `run()` becomes a long-lived async iterator that
yields `result` events as turn boundaries, and exposes a
`writeUserMessage(msg)` method the runner calls between turns.

This refactor stays inside the Claude executor + the runner; it
does not touch the `Executor` interface other executors
implement. Other executors that don't support mid-session input
SHALL set `supportsNudge: false` on the executor capability
flag (see "Executor capability flag" below), and the runner
SHALL skip the nudge loop for those executors.

## `output_nudge_budget` semantics

```yaml
nodes:
  security-review:
    outputs:
      findings: { type: value, required: true }
    output_nudge_budget: 1   # default
```

- Default: `1`. Conservative — one shot at recovery, then defer
  to the graph-level retry edge.
- Range: any non-negative integer. `0` opts out cleanly.
- No factory-level default exists. Every node carries its own
  budget; the schema's `.default(1)` populates the field at
  load time if absent.
- Scope: per node iteration. A re-dispatch of the same node
  (via a graph-level recovery edge or a cycle) gets a fresh
  budget. This matches the iteration-scoped semantics of
  `max_iterations`, `priorResults` accumulation, and the
  outputs directory naming.

## Nudge message construction — `buildNudgeMessage`

The runner constructs the synthetic user message from the
missing-outputs list. The helper lives at `src/runner/nudge.ts`
and is unit-tested in isolation.

```typescript
type MissingOutput = {
  key: string;
  type: "value" | "file" | "directory";
  expected_path: string;   // absolute filesystem path
  detail: string;          // "absent" | "parse error: ..." | "ambiguous" | "empty"
};

function buildNudgeMessage(missing: MissingOutput[]): string;
```

Canonical output (from the decision doc, lightly normalized for
the helper's bullet-list rendering):

```
The following declared required outputs were not produced:

  - findings (type: value): expected at <outputs_dir>/findings.json
  - report  (type: file):   expected at <outputs_dir>/report.md

Please produce these outputs now. After they're written,
emit MINIFAC_STATUS: succeeded (or MINIFAC_STATUS: failed
with a REASON if you cannot produce them).
```

Bullets align the key column for legibility but do not require
column alignment — single spaces between fields are fine; the
test asserts the structure (header line, one bullet per
missing key, closing paragraph), not the exact whitespace.

The `detail` field is included only when it adds information
beyond "absent" (e.g. "parse error: unexpected end of input").
For the common "file just isn't there" case, the bullet
collapses to `- <key> (type: <type>): expected at <path>`.

## Event tagging

The Claude executor today yields events with an existing kind
taxonomy (the predecessor change's spec uses tags like
`assistant / text`, `tool_use`, `result`). The nudge loop adds
two runner-emitted kinds:

- `system / runner-action` — operator-visible narration.
  Payload is the one-line string
  `"Required outputs missing, nudging (budget remaining: N)..."`.
- `user / runner-nudge` — the synthetic user message itself.
  Payload is the full `buildNudgeMessage` output.

Both events are tagged with the originating `nodeId` and the
current iteration so the runs.db replay and the live TUI / web
viewer can render them distinctly from model output. The
event pipeline persists them through the existing event store
hook; no migration is required.

## Broken stdin

When the stdin write fails (EPIPE, executor exited between
`result` and the runner's reply, OS-level write error), the
runner:

1. Catches the write error.
2. Does **not** retry the write.
3. Records the failure as `missing_required_output` with the
   stdin-write error preserved in the failure metadata
   (`missing_outputs_detail` gains a suffix like
   `"; nudge stdin write failed: EPIPE"`).
4. Does not consume further executor events — the executor is
   already gone or going.

Rationale: a broken pipe between a `result` event and the
runner's nudge reply is almost always an executor crash or a
mid-session timeout. The graph-level retry edge owns recovery
from that, not the in-turn nudge loop.

## Executor capability flag — `supportsNudge`

To keep the runner generic, the executor interface grows a
`supportsNudge: boolean` flag (analogous to the existing
`supportsMcp` flag added by `node-outputs-mcp`). Executors that
can accept post-`result` user messages on stdin set this to
`true`; others set `false`.

The Claude executor sets `supportsNudge: true`. When (and only
when) `supportsNudge: true` AND `output_nudge_budget > 0` AND
outputs are missing, the runner enters the nudge loop. For
executors with `supportsNudge: false`, the runner skips the
nudge loop entirely and falls through to the existing override-
to-failed path; the `output_nudge_budget` field is accepted at
schema time but has no runtime effect.

This avoids the runner attempting to write to stdin on
executors that can't consume it, and keeps the cross-cutting
capability negotiation in the same shape as the MCP layer.

## `NodeResult.nudges_used`

```typescript
type NodeResult = {
  // ... existing fields ...
  outputs: NodeOutputIndex | null;
  nudges_used: number;   // default 0
};
```

The field defaults to `0` for nodes that never enter the nudge
loop (sentinel-failed, outputs-valid-first-try, no
`outputs:` declared). It is non-zero only when the runner
actually wrote one or more nudge messages.

The field persists through the existing `NodeResult` JSON
serialization in the runs.db `node_executions` row; no schema
change. The runs CLI's `show` subcommand surfaces it as a
trailing column when non-zero (small, optional follow-up — not
required by this change's acceptance criteria, but cheap).

## Rejected alternatives (recap)

The decision doc covers these — repeated here only to anchor
the design against them:

- **No nudge — first attempt or fail.** Rejected: wastes the
  full prior work on a recoverable protocol mistake.
- **Unlimited nudges.** Rejected: risks infinite loops when the
  model is confused.
- **Default budget 2.** Rejected: a second shot mostly
  represents the model confabulating outputs to satisfy the
  contract.
- **Out-of-band notification (email, log).** Rejected: the
  model needs the missing-outputs info *in its working
  context*.
- **Always nudge regardless of sentinel state.** Rejected:
  forces re-litigation of work the model already reported it
  couldn't complete.

## Test plan

Unit tests:

- `src/runner/nudge.test.ts` — `buildNudgeMessage` covers
  single-missing-output, multi-missing-output, with/without
  detail strings.
- `src/factory/schema.test.ts` — `output_nudge_budget` accepts
  `0`, `1`, `5`; rejects `-1`, `1.5`, `"1"`.
- `src/runner/run.test.ts` (or wherever the existing
  outputs-validation tests live) — the seven scenarios from the
  graph-runner delta:
  - Default budget (`1`): missing outputs → nudge → model
    fixes → `succeeded`, `nudges_used: 1`.
  - Default budget (`1`): missing outputs → nudge → model
    still doesn't fix → `failed` with
    `missing_required_output`, `nudges_used: 1`.
  - Budget `0`: missing outputs → immediate `failed`, no nudge
    sent, `nudges_used: 0`.
  - Sentinel `failed`: no nudge regardless of outputs state,
    `nudges_used: 0`.
  - Sentinel `succeeded` with no missing outputs: no nudge,
    `nudges_used: 0`.
  - Budget `3` with two nudges needed: two nudges sent,
    third turn succeeds, `nudges_used: 2`.
  - Broken stdin during nudge: immediate `failed` with
    metadata recording the stdin-write error,
    `nudges_used: 0` (the failed write does not count as a
    nudge consumed because the model never received it).
- `src/runner/run.test.ts` — runner-emitted events tagged
  correctly: a nudge fire produces exactly one
  `system / runner-action` event followed by exactly one
  `user / runner-nudge` event, both carrying the right nodeId
  and iteration, both visible on the consumer passed to
  `runFactory`.
- `src/storage/sqlite.test.ts` — runner-emitted events
  persist through the existing event store hook; querying
  the run's events back yields both the `runner-action` and
  `runner-nudge` rows in order.

The existing `node-outputs` tests should continue to pass
unchanged. Where a test asserted "missing outputs → failed"
the new code path runs an extra turn before the failure;
those tests SHALL be updated to set
`output_nudge_budget: 0` so they continue to assert the
single-turn semantics they originally meant.
