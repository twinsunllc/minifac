## Why

`node-outputs` introduced declared required outputs and the
`missing_required_output` failure mode: when the model emits
`MINIFAC_STATUS: succeeded` but doesn't produce a declared
required output, the runner overrides to failed. That is the
correct contract but wasteful when the failure is *protocol*
(forgot a tool call / forgot a file write) rather than
*substantive* (the work really didn't land). The whole node
gets re-run through the graph-level recovery edge for the cost
of a single missed `Write`.

The binding decision is at
`docs/decisions/0028-Node-Outputs-Nudge.md`. The Claude CLI in
stream-json mode accepts new user messages over stdin **after**
a `result` event — that event signals end-of-turn, not
end-of-session. The runner can hand the model another turn with
a synthetic user message describing what's missing, and the
model has one shot to call the right tool / write the right
file before the runner gives up. This is the same principle as
the existing graph-level recovery edge (`verify → apply when:
on_failure`), applied one abstraction level down: graph cycles
handle substantive failures; the nudge handles protocol
failures.

Depends on `node-outputs` having landed.

## What Changes

- **NEW** `output_nudge_budget` field on factory nodes — a
  non-negative integer (default `1`) declaring how many in-turn
  nudge retries the runner MAY use to recover a missing-output
  protocol mistake before giving up and recording the node as
  `failed` with reason `missing_required_output`. Per-node
  override; no factory-level default. Setting `0` opts the node
  out of nudging entirely.
- **NEW** post-execution nudge loop in the runner. After the
  executor emits its terminal `result` event AND the sentinel
  reported `succeeded` AND the outputs validator finds missing
  required outputs AND the node's remaining nudge budget is
  greater than zero, the runner SHALL construct a synthetic user
  message naming the missing outputs and write it to the still-
  open executor stdin as a properly-framed user-message event.
  The runner SHALL then wait for the next `result` event,
  re-validate outputs, and either record `succeeded`, send
  another nudge if budget remains, or record `failed` with
  reason `missing_required_output`.
- **NEW** sentinel-failed nodes are never nudged. The nudge loop
  is entered only when the sentinel reports `succeeded`; a node
  that honestly reported failure gets to fail in peace, per the
  existing `node-outputs` "Failed-sentinel node skips outputs
  validation" scenario.
- **NEW** runner-emitted nudge events on the executor's event
  stream. The runner SHALL emit two new event kinds when a
  nudge is sent:
  - `system / runner-action` — a one-line operator-visible
    note (`"Required outputs missing, nudging (budget
    remaining: N)..."`) so dashboards / TUI / runs.db replay
    can render runner interventions distinctly from model
    output.
  - `user / runner-nudge` — the nudge message itself, tagged so
    it is visually distinguishable from genuine user
    messages.
  Both events SHALL carry the originating `nodeId` and the
  current node iteration, and SHALL be persisted through the
  existing event pipeline into `runs.db` like any other event.
- **NEW** `NodeResult.nudges_used` field — a non-negative
  integer (default `0`) recording how many nudges the runner
  spent on the node iteration. Useful for observability ("which
  factories nudge a lot?") and future cost analysis.
- **NEW** broken-stdin failure path. When the nudge stdin write
  fails (broken pipe, EPIPE, executor exited between `result`
  and the runner's reply), the runner SHALL treat the failure
  as immediate `missing_required_output` — no recovery attempt
  beyond the failed write itself. The cause is recorded in the
  failure metadata so operators can distinguish stdin-write
  failures from genuine output omissions.
- **NEW** documentation. `docs/concepts/Outputs.md` (created by
  `node-outputs`) grows a "Nudge recovery" section explaining
  the protocol; `docs/concepts/Factory.md`'s Schema section
  grows an `output_nudge_budget:` row alongside `outputs:`.

## Capabilities

### New Capabilities

(none — the nudge loop is woven into the existing graph-runner
capability that already owns post-execution outputs validation.
Creating a separate capability for a feature this tightly
coupled to validation would fragment the spec without separating
any new component boundary.)

### Modified Capabilities

- `factory-schema`: ADD a requirement for the per-node
  `output_nudge_budget` field; MODIFY the existing "Node
  definition" requirement to include `output_nudge_budget` in
  the accepted node-level key set.
- `graph-runner`: ADD a requirement for the post-execution
  nudge loop (covering the trigger conditions, the nudge
  message construction, the stdin write, the event emission,
  the budget arithmetic, and the broken-stdin failure path);
  ADD a requirement for the `NodeResult.nudges_used` field;
  MODIFY the existing "Post-execution outputs validation"
  requirement to mention that the nudge loop sits between the
  initial outputs-missing detection and the terminal-status
  override (the override fires only when no budget remains);
  MODIFY the existing "Streaming node events" requirement to
  cover the new `system / runner-action` and `user /
  runner-nudge` event kinds.

## Impact

- `src/factory/schema.ts` — add
  `output_nudge_budget: z.number().int().nonnegative()
  .optional().default(1)` to the node shape; extend the
  node-level accepted-key-set validator to include the new
  field; mirror the new field in `src/factory/types.ts` (or
  wherever node-level types live) so the runner can read it.
- `src/runner/run.ts` — refactor the post-execution flow into
  the nudge-loop shape described in
  `docs/decisions/0028-Node-Outputs-Nudge.md`: parse sentinel,
  short-circuit on sentinel-failed, validate outputs, on
  missing-outputs check remaining budget, write nudge to stdin
  and increment the in-runner nudges-used counter, wait for
  next `result` event, re-validate, repeat until success / no
  budget / stdin error.
- `src/runner/nudge.ts` (new) — `buildNudgeMessage(missing:
  MissingOutput[]): string` helper that constructs the
  canonical nudge text from the missing-outputs list. Tested
  in isolation. The runner imports this helper rather than
  inlining the message construction.
- `src/runner/claude-executor.ts` (or wherever the Claude
  executor lives) — expose a `writeUserMessage(msg)` method
  that frames the message as a stream-json user-message event
  and writes it to the executor's stdin. The runner calls this
  from the nudge loop. The executor keeps stdin open across
  turns (it already does, per the decision doc — but verify
  during implementation).
- `src/executor/types.ts` — extend `NodeResult` with
  `nudges_used: number` (defaults to `0`). Extend the executor
  event-kind enum (or whatever event taxonomy the executor
  yields) with `runner-action` and `runner-nudge` tags.
- `src/storage/sqlite.ts` — no schema change. The new events
  ride the existing event pipeline; the new `nudges_used`
  field rides the existing `NodeResult` persistence (already
  serialized as JSON in the node-end row).
- `docs/concepts/Outputs.md` — append a "Nudge recovery"
  section.
- `docs/concepts/Factory.md` — extend the Schema section's
  node-level table with an `output_nudge_budget:` row.
- Tests alongside each module per the project convention.

### Out of scope

- Customizable nudge messages per factory. Factory authors do
  not write their own retry copy in v1; the runner owns the
  canonical message. Revisit when someone asks.
- Multi-budget defaults (`> 1`). Default stays at `1`.
  Factories can set higher per-node if they really want, but
  the default is intentional — empirically one shot covers the
  "model forgot" case; a second shot mostly represents "model
  is confused and confabulating to satisfy the contract,"
  which is worse than just failing the node.
- Nudging on sentinel-failed nodes. The sentinel said no; the
  graph-level retry edge owns recovery there.
- Cross-iteration nudge budget accounting. The budget is per
  node iteration. A node that runs twice (iteration 1 fails,
  iteration 2 runs after a graph-level retry edge) gets a
  fresh nudge budget on iteration 2. This matches the
  iteration-scoped semantics of every other per-dispatch
  budget in the runner.
- Nudge events affecting the stream-event timing semantics in
  ways that observers might cache against. Observers that care
  about turn boundaries already key off the `result` event;
  the nudge loop just runs an extra turn between two `result`
  events, no different from the model having more to say.
