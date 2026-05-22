## ADDED Requirements

### Requirement: Post-execution nudge loop

The runner SHALL run an in-turn nudge loop after the outputs validator (per the "Post-execution outputs validation" requirement) finds one or more declared required outputs unsatisfied, before recording the node's terminal status, when ALL of the following hold: the sentinel reports `succeeded`, the dispatching executor's `supportsNudge` capability flag is `true`, and the node's remaining nudge budget is greater than zero. Each iteration of the loop SHALL execute the following steps:

1. Build a `MissingOutput` list from the validator's result. Each
   entry SHALL carry the declared output key, its declared type
   (`value` | `file` | `directory`), the expected absolute
   filesystem path the validator scanned, and (when present and
   non-trivial) the validator's detail string describing the
   specific failure mode (parse error / ambiguous / empty).
2. Construct a synthetic user-message string by passing the
   `MissingOutput` list to the `buildNudgeMessage` helper. The
   helper's output SHALL be the canonical nudge message: a
   header line ("The following declared required outputs were
   not produced:"), one bullet per missing key naming key,
   type, and expected path (plus detail when non-trivial), and
   a closing paragraph instructing the model to produce the
   outputs and emit `MINIFAC_STATUS: succeeded` (or `failed`
   with a `REASON` if it cannot).
3. Emit a `system / runner-action` event on the runner's
   `onEvent` consumer with the one-line operator-visible note
   `"Required outputs missing, nudging (budget remaining:
   N)..."` where `N` is the budget remaining AFTER this nudge
   is sent (`current_budget - 1`). The event SHALL carry the
   originating `nodeId` and the current node iteration.
4. Emit a `user / runner-nudge` event on the runner's `onEvent`
   consumer carrying the full `buildNudgeMessage` output as its
   payload. The event SHALL carry the originating `nodeId` and
   the current node iteration.
5. Call the executor's `writeUserMessage(nudgeMessage)` method.
   The method SHALL frame the message as a stream-json
   user-message event and write it to the executor's stdin.
6. On successful stdin write, increment the runner-local
   `nudges_used` counter, decrement the remaining budget, and
   resume draining executor events until the next `result`
   event lands. Then re-run the outputs validator; loop again
   from step 1 if outputs are still missing AND budget > 0;
   record `succeeded` if outputs are valid; record `failed`
   with reason `missing_required_output` if outputs are still
   missing AND budget = 0.
7. On stdin write failure (EPIPE, EBADF, OS error), the runner
   SHALL break out of the loop with a synthetic terminal
   status of `failed` and reason
   `missing_required_output`. The `NodeResult.meta` (or
   runner-internal failure metadata) SHALL preserve the
   standard `missing_outputs` array from the validator's last
   pass AND extend `missing_outputs_detail` with a suffix
   describing the stdin-write failure (e.g.
   `"; nudge stdin write failed: EPIPE"`). The runner SHALL
   NOT count a failed write as a consumed nudge — the
   `nudges_used` counter reflects only nudges the model
   actually received.

The per-dispatch nudge budget SHALL be sourced from the
resolved node's `output_nudge_budget` field (per the
`factory-schema` capability's "`output_nudge_budget` per-node
field" requirement; default `1` after schema validation). The
budget is per-node-iteration: a re-dispatch of the same node
via a graph-level recovery edge or a cycle SHALL start with a
fresh budget read from the schema. No cross-iteration carryover.

When the resolved executor's `supportsNudge` flag is `false`,
the runner SHALL NOT enter the nudge loop regardless of
`output_nudge_budget`; missing outputs fall through directly
to the existing override-to-failed path established by
"Post-execution outputs validation". The schema-populated
`output_nudge_budget` field has no runtime effect on
non-nudge-capable executors.

The nudge loop SHALL NOT be entered when:

- The node's terminal sentinel reported `failed` (the
  validation pass is already skipped per the existing
  contract; the nudge loop is downstream of validation).
- The node declared no `outputs:` block (no validation runs).
- All declared required outputs are satisfied on first
  validation pass.
- `output_nudge_budget` is `0`.
- The executor's `supportsNudge` is `false`.

In all of these cases, the existing post-execution flow
proceeds unchanged: outputs valid → record `succeeded`;
outputs missing AND budget zero → record `failed` with
`missing_required_output`.

#### Scenario: Default budget recovers a forgotten output

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`
  with `output_nudge_budget: 1` (default) and a
  `supportsNudge: true` executor; the first turn terminates
  `MINIFAC_STATUS: succeeded` but `findings.json` is not on
  disk; the nudge fires; the model writes `findings.json`
  during the second turn and terminates `succeeded`
- **THEN** the runner records the node as `succeeded`; the
  `NodeResult.outputs` carries the `findings` entry; the
  `NodeResult.nudges_used` is `1`

#### Scenario: Default budget exhausted, node fails

- **WHEN** node `propose` declares the same outputs +
  default budget as above; the first turn terminates
  `succeeded` with no `findings.json`; the nudge fires; the
  second turn also terminates `succeeded` without writing
  `findings.json`
- **THEN** the runner records the node as `failed` with
  reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["findings"]`; the
  `NodeResult.nudges_used` is `1`

#### Scenario: Budget zero opts out of nudging cleanly

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`
  with `output_nudge_budget: 0`; the turn terminates
  `succeeded` with no `findings.json`
- **THEN** the runner records the node as `failed` with
  reason `missing_required_output` on the first validation
  pass; no nudge events are emitted; no nudge message is
  written to stdin; the `NodeResult.nudges_used` is `0`

#### Scenario: Sentinel-failed node skips the nudge loop

- **WHEN** node `verify` declares
  `outputs: { results: { type: "value", required: true } }`
  with `output_nudge_budget: 1` and terminates `failed` with
  reason `"verify hit 3 test failures"` (sentinel failure)
- **THEN** the outputs validation pass is skipped per the
  existing contract; the nudge loop is not entered; the
  node's terminal status remains `failed` with the sentinel
  reason preserved verbatim; the
  `NodeResult.nudges_used` is `0`

#### Scenario: Higher budget allows multiple nudge attempts

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`
  with `output_nudge_budget: 3`; the first turn terminates
  `succeeded` without `findings.json`; the first nudge
  fires; the second turn still does not write the file; the
  second nudge fires; the third turn writes the file and
  terminates `succeeded`
- **THEN** the runner records the node as `succeeded`; the
  `NodeResult.nudges_used` is `2`; the executor's event
  stream carries two `system / runner-action` events and
  two `user / runner-nudge` events in order, interleaved
  with the model's three turns

#### Scenario: Broken stdin during nudge fails the node immediately

- **WHEN** node `propose` declares an outputs block with
  `output_nudge_budget: 1`, the first turn terminates
  `succeeded` without producing the required output, the
  runner emits the `runner-action` and `runner-nudge`
  events, and the subsequent
  `executor.writeUserMessage()` call rejects with EPIPE
  (the executor process has exited between the `result`
  event and the runner's reply)
- **THEN** the runner records the node as `failed` with
  reason `missing_required_output`; the
  `missing_outputs_detail` string carries a suffix
  identifying the stdin-write failure (e.g. "; nudge
  stdin write failed: EPIPE"); the
  `NodeResult.nudges_used` is `0` (the failed write does
  not count as a consumed nudge)

#### Scenario: Sentinel-succeeded node with no missing outputs skips the loop

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`
  with `output_nudge_budget: 1` and the first turn
  terminates `succeeded` with `findings.json` written
- **THEN** the validator passes on the first pass; the
  nudge loop is not entered; the node is recorded as
  `succeeded`; no nudge events are emitted;
  `NodeResult.nudges_used` is `0`

#### Scenario: Non-nudge-capable executor skips the loop

- **WHEN** the dispatching executor exposes
  `supportsNudge: false` and the node declares
  `outputs: { findings: { type: "value", required: true } }`
  with `output_nudge_budget: 1`; the turn terminates
  `succeeded` without writing the file
- **THEN** the runner records the node as `failed` with
  reason `missing_required_output` on the first validation
  pass; no nudge events are emitted; the schema-populated
  `output_nudge_budget: 1` has no runtime effect because
  the executor cannot accept post-`result` user messages;
  `NodeResult.nudges_used` is `0`

#### Scenario: Iteration boundary resets the budget

- **WHEN** node `apply` declares `output_nudge_budget: 1`,
  iteration 1 fails with `missing_required_output` after
  consuming its single nudge, a graph-level recovery edge
  re-dispatches the node, and iteration 2 starts
- **THEN** iteration 2's effective nudge budget is `1`
  (the full schema-declared value, not zero); the budget
  is per-iteration and does not carry forward from a
  prior dispatch

### Requirement: `NodeResult.nudges_used` field

The runner SHALL extend the `NodeResult` shape (per the
existing "Prior-results accumulate across node executions"
requirement) with a `nudges_used` field whose value SHALL be
a non-negative integer recording how many nudges the runner
spent on the node iteration. The field SHALL default to `0`
and SHALL be incremented each time the runner successfully
writes a nudge message to the executor's stdin (per the
"Post-execution nudge loop" requirement, step 6). The field
SHALL NOT be incremented when a stdin write fails (step 7).

The field SHALL be populated for every node iteration,
regardless of whether the node entered the nudge loop. Nodes
that never enter the loop (sentinel-failed,
outputs-valid-first-try, no `outputs:` declared, budget zero,
non-nudge-capable executor) SHALL record
`nudges_used: 0`.

The field SHALL persist through the existing `NodeResult`
JSON serialization in the run-storage layer's `recordNodeEnd`
hook. No schema migration is required; the field rides the
existing JSON-blob column.

#### Scenario: NodeResult records zero nudges for first-try success

- **WHEN** a node terminates `succeeded` with all required
  outputs present on the first validation pass
- **THEN** the recorded `NodeResult.nudges_used` is `0`

#### Scenario: NodeResult records the nudge count on recovery

- **WHEN** a node enters the nudge loop, the runner sends
  two nudges, and the third turn produces the required
  outputs
- **THEN** the recorded `NodeResult.nudges_used` is `2`

#### Scenario: NodeResult records zero nudges on sentinel failure

- **WHEN** a node terminates `failed` with a sentinel
  reason and the nudge loop is skipped
- **THEN** the recorded `NodeResult.nudges_used` is `0`

#### Scenario: NodeResult records the consumed count on budget exhaustion

- **WHEN** a node declares `output_nudge_budget: 2`, the
  runner sends both nudges, and outputs are still missing
  after the third turn
- **THEN** the recorded `NodeResult.nudges_used` is `2`;
  the node is recorded as `failed` with reason
  `missing_required_output`

## MODIFIED Requirements

### Requirement: Streaming node events

While a node is executing, the runner SHALL forward every event yielded
by that node's executor (`stdout`, `stderr`, `status`) to a consumer
provided at run invocation, in order, without buffering beyond what is
necessary to deliver one event at a time.

The runner SHALL also emit two runner-originated event kinds
on the same consumer when the post-execution nudge loop (per
the "Post-execution nudge loop" requirement) fires:

- `system / runner-action` — an operator-visible one-line note
  whose payload identifies the nudge action and the budget
  remaining after the nudge is sent.
- `user / runner-nudge` — the synthetic user-message string
  passed to the executor's stdin via the
  `writeUserMessage()` call, exposed on the event stream so
  observers see the same message the model receives.

Both runner-originated event kinds SHALL carry the originating
`nodeId` and the current node iteration so downstream
consumers (live TUI, web viewer, runs.db replay) can attribute
the events to the right node-iteration row. The events SHALL
flow through the existing event pipeline and SHALL be
persisted by the run-storage layer the same way model events
are.

#### Scenario: Consumer sees events as they arrive

- **WHEN** an executor yields three `stdout` events spaced 100ms apart
- **THEN** the consumer receives them in order, each within a small
  constant of the time the executor yielded it (no batching at end of run)

#### Scenario: Consumer sees runner-action and runner-nudge events in order

- **WHEN** a node's post-execution nudge loop fires once (one
  nudge sent), bracketed by the model's two turns
- **THEN** the consumer sees, in order: the first turn's
  events ending in `result`, a `system / runner-action`
  event with the nudge note, a `user / runner-nudge` event
  carrying the synthetic user message, the second turn's
  events ending in `result`

#### Scenario: Runner-originated events are tagged with nodeId and iteration

- **WHEN** the runner fires a nudge during node `propose`
  iteration 2
- **THEN** the emitted `system / runner-action` and
  `user / runner-nudge` events both carry `nodeId:
  "propose"` and `iteration: 2`

### Requirement: Post-execution outputs validation

The runner SHALL validate each node's declared outputs against the contents of its outputs directory after the executor terminates and the node's terminal status is resolved (per existing event-drain rules) and before recording the entry in `priorResults` / invoking the store's `recordNodeEnd`.

The validation pass is **transport-agnostic**: it scans
`<outputs_dir>` from disk regardless of how outputs landed
there. For `type: "value"` outputs, two transports are
supported in v1:

- **MCP transport.** When the resolved executor's
  `supportsMcp` flag is `true`, the runner SHALL register
  per-output MCP tools (per the "Per-node MCP tool
  registration for `value` outputs" requirement) and the model
  is expected to report values via tool calls. The bridge
  writes `<outputs_dir>/<key>.json` atomically (per the
  "MCP-to-filesystem bridge for `value` output tool calls"
  requirement) so the validator sees the same file the v1
  filesystem transport produced.
- **Filesystem-JSON fallback.** When the resolved executor's
  `supportsMcp` flag is `false`, OR the model uses its
  ordinary Write tool to land a JSON file at
  `<outputs_dir>/<key>.json` even when MCP tools are
  available, the validator SHALL pick up the file via the
  same scan path. Both transports converge at the same
  on-disk contract.

For `type: "file"` and `type: "directory"` outputs, there is
only one transport — the model writes files via its existing
Write tool. No MCP tools are exposed for these output types.

Validation SHALL run only when ALL of the following hold:

- The node declares an `outputs:` block (per the
  `factory-schema` capability's "Node `outputs:` block"
  requirement); AND
- The node's resolved terminal status is `succeeded` (sentinel
  succeeded; non-sentinel exit-zero terminations also count).

When the node's resolved terminal status is `failed` for any
reason (sentinel failure, non-zero exit, executor error), the
outputs validation pass SHALL be skipped entirely. The node's
existing failure reason is preserved; the `NodeResult.outputs`
field SHALL be `null` for a skipped-validation node.

For each declared output `(key, def)` in the node's `outputs:`
map, the validator SHALL:

- **`type: "value"`** — look for `<outputs_dir>/<key>.json`. If
  present, attempt to parse it as JSON. If the file is missing,
  treat as absent. If the file exists but JSON parse fails,
  treat as **present-but-invalid** (counts the same as missing
  for required-output purposes; the validator records the parse
  error in the failure reason text). The validator SHALL ignore
  any sibling `.tmp-*` files left by an interrupted MCP write
  (those do not match the `<key>.json` filename).
- **`type: "file"`** — when `def.filename` is set, look for
  `<outputs_dir>/<def.filename>`. When `def.filename` is absent,
  glob `<outputs_dir>/<key>.*` (one or more characters after the
  dot). Zero matches → absent. Exactly one match → present, path
  is the match. Multiple matches → **present-but-ambiguous**
  (counts the same as missing; the validator records "ambiguous
  file output matched N files: <list>" in the failure reason).
- **`type: "directory"`** — look for `<outputs_dir>/<key>/` as a
  directory. Missing or not-a-directory → absent. Empty directory
  → **present-but-empty** (counts the same as missing). Directory
  with one or more files (at any depth) → present.

For each present output, the validator SHALL stat the file (or
the directory) and record `{ type, path, size, mtime }` in the
`NodeOutputIndex` for that node iteration:

- `path` is the absolute filesystem path.
- `size` is the file size in bytes for `value` and `file`
  outputs; for `directory` outputs, the total recursive byte
  count of contained files.
- `mtime` is the file's `mtime` in epoch ms for `value` and
  `file` outputs; for `directory` outputs, the latest `mtime`
  of any contained file.

After scanning all declared outputs, the validator SHALL collect
the keys whose `required: true` declaration is unsatisfied
(absent, present-but-invalid, present-but-ambiguous, or
present-but-empty). When that set is non-empty, the runner's
next step SHALL be governed by the "Post-execution nudge loop"
requirement, NOT an immediate terminal-status override.

Specifically:

- When the dispatching executor's `supportsNudge` flag is
  `true` AND the node's remaining nudge budget is greater
  than zero, the runner SHALL invoke the nudge loop per the
  "Post-execution nudge loop" requirement. The validator's
  unsatisfied-set determines the nudge message payload; the
  loop may re-invoke this validation pass on subsequent
  turns until outputs are satisfied or budget is exhausted.
- When `supportsNudge` is `false` OR the remaining nudge
  budget is zero (including the case where the budget was
  spent by prior nudge iterations in the same dispatch), the
  validator SHALL override the node's terminal status as
  described below.

When the validator's unsatisfied-set is non-empty AND no
further nudges will be attempted (per the conditions above),
the validator SHALL override the node's terminal status:

- New status: `failed`
- New `reason`: the string `missing_required_output`
- The `NodeResult.meta` (or equivalent runner-internal failure
  metadata) SHALL carry `missing_outputs: string[]` listing the
  offending keys, and a `missing_outputs_detail` string naming
  each key's specific failure mode (absent / parse error /
  ambiguous / empty). When MCP tools were available for the
  node (`supportsMcp: true`) but the model did not call them
  (and did not write the file via the fallback path either),
  the detail string SHALL note the transport context (e.g.
  `"absent (MCP tool mcp__minifac__report_findings was available but not called; no fallback file at findings.json either)"`)
  to aid the operator in diagnosing the gap. When the nudge
  loop was attempted and exhausted, the detail string SHALL
  also note the number of nudges spent.

The `NodeOutputIndex` (for the keys that *were* present) SHALL
still be populated and persisted even when the override fires;
operators inspecting the failed node can still see what the model
did write.

When all required outputs are satisfied (or none are required),
the node's existing terminal status is preserved unchanged and
the `NodeOutputIndex` is populated for every present output
(required and optional).

#### Scenario: Required value output landed via MCP passes

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`,
  the dispatching executor's `supportsMcp` is `true`, the
  model calls `mcp__minifac__report_findings({ value: [...] })`,
  and the bridge writes `<outputs_dir>/findings.json`
- **THEN** the validator finds the file, parses it as JSON,
  the node's terminal status remains `succeeded`, and the
  `NodeOutputIndex` carries
  `findings: { type: "value", path, size, mtime }`

#### Scenario: Required value output landed via Write fallback passes

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`,
  the dispatching executor's `supportsMcp` is `true`, the
  model uses its ordinary Write tool to land
  `<outputs_dir>/findings.json` directly (ignoring the MCP
  tool)
- **THEN** the validator finds the file, parses it as JSON,
  the node's terminal status remains `succeeded`, and the
  `NodeOutputIndex` carries the standard present-output
  entry; the MCP transport's availability does not change the
  validator's behavior when the file is present

#### Scenario: Required value output landed via filesystem-JSON on non-MCP executor

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`
  and the dispatching executor's `supportsMcp` is `false`
- **THEN** no MCP tool is registered; the model writes the
  file via its own tools; the validator finds the file at
  `<outputs_dir>/findings.json` and the node's terminal status
  remains `succeeded`

#### Scenario: Required value output absent with MCP available records transport detail

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`,
  the executor's `supportsMcp` is `true`, the MCP tool was
  registered, the model neither called the tool nor wrote
  `findings.json` via Write, the node terminates
  `succeeded`, AND `output_nudge_budget: 0` (the nudge
  loop is opted out so the override fires immediately)
- **THEN** the validator overrides the terminal status to
  `failed` with reason `missing_required_output`; the
  `missing_outputs_detail` string mentions both the
  un-called MCP tool name (`mcp__minifac__report_findings`)
  and the absent fallback file (`findings.json`)

#### Scenario: Required value output absent on non-MCP executor records simple detail

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`,
  the executor's `supportsMcp` is `false`, the executor's
  `supportsNudge` is also `false`, the model did not
  write `findings.json`, and the node terminates `succeeded`
- **THEN** the validator overrides the terminal status to
  `failed` with reason `missing_required_output` on the
  first pass (the nudge loop is skipped because the
  executor cannot accept post-`result` user messages); the
  `missing_outputs_detail` string names the absent file
  without referencing MCP (the transport was not in scope)

#### Scenario: Required file output absent fails the node

- **WHEN** node `apply` declares `outputs: { patch:
  { type: "file", filename: "patch.diff", required: true } }`
  with `output_nudge_budget: 0`, terminates `succeeded`, and
  `<outputs_dir>/patch.diff` does not exist (MCP does not
  apply to file outputs; nudge loop opted out)
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["patch"]`

#### Scenario: Required directory output empty fails the node

- **WHEN** node `verify` declares `outputs: { logs:
  { type: "directory", required: true } }` with
  `output_nudge_budget: 0`, terminates `succeeded`, and
  `<outputs_dir>/logs/` exists but contains no files (MCP
  does not apply to directory outputs; nudge loop opted out)
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["logs"]`

#### Scenario: Failed-sentinel node skips outputs validation

- **WHEN** node `verify` declares `outputs: { results:
  { type: "value", required: true } }` and terminates `failed`
  with reason `"verify hit 3 test failures"` (sentinel failure)
- **THEN** the outputs validation pass is skipped regardless
  of whether MCP tool calls landed during the dispatch; the
  node's terminal status remains `failed` with the sentinel
  reason preserved verbatim; `NodeResult.outputs` is `null`;
  the nudge loop is not entered

#### Scenario: Missing outputs route through the nudge loop when budget remains

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`
  with `output_nudge_budget: 1`, the dispatching executor's
  `supportsNudge` is `true`, the first turn terminates
  `succeeded` without writing `findings.json`
- **THEN** the validator's unsatisfied-set drives the nudge
  loop (per the "Post-execution nudge loop" requirement)
  rather than triggering an immediate terminal-status
  override; the override fires only if outputs remain
  missing after the budget is exhausted
