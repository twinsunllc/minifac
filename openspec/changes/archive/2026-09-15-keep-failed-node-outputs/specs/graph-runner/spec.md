## ADDED Requirements

### Requirement: Prior-result status and reason tokens

In addition to the `priorResults.<node-id>.outputs.<key>[:read]`
forms (per the "Brief token substitution before node dispatch"
requirement), the runner SHALL substitute two further tokens under the
`priorResults` namespace, resolved against the same latest-iteration
`Map<nodeId, NodeResult>`:

- `priorResults.<node-id>.status`: substitute the latest entry's
  `status` — the literal string `succeeded` or `failed`.
- `priorResults.<node-id>.reason`: substitute the latest entry's
  `reason` string verbatim (the sentinel REASON,
  `missing_required_output`, `resume_unavailable`,
  `resume_unsupported`). When `reason` is `null`, substitute the empty
  string.

When the named node has no prior result in this run, both tokens
SHALL substitute the empty string (the same convention as a missing
output key). These tokens are resolved at dispatch time only; the
load-time inputs pass SHALL leave them verbatim, so a token supplied
through a `uses:` node's `inputs:` reaches the dispatch pass intact.

#### Scenario: `{{ priorResults.<id>.status }}` on a failed source

- **WHEN** node `evaluate` terminates `failed` with sentinel REASON
  `"revise: two criteria unmet"` and node `implement` (reached via
  `on_failure`) has `with.prompt`
  `"evaluate ended {{ priorResults.evaluate.status }}: {{ priorResults.evaluate.reason }}"`
- **THEN** the executor receives the prompt
  `"evaluate ended failed: revise: two criteria unmet"`

#### Scenario: `{{ priorResults.<id>.status }}` on a succeeded source with null reason

- **WHEN** node `plan` terminates `succeeded` with no sentinel REASON
  and a downstream prompt is
  `"{{ priorResults.plan.status }}/{{ priorResults.plan.reason }}"`
- **THEN** the executor receives `"succeeded/"`

#### Scenario: Status token with no prior result substitutes empty

- **WHEN** a prompt references `{{ priorResults.nonexistent.status }}`
  and no node `nonexistent` has run
- **THEN** the token substitutes the empty string

#### Scenario: Status token passes through a `uses:` node's inputs

- **WHEN** a `uses:` node supplies
  `inputs: { verdict: "{{ priorResults.evaluate.status }}" }` to a
  step whose body contains `{{ inputs.verdict }}`
- **THEN** the inlined prompt still contains the literal
  `{{ priorResults.evaluate.status }}` after load, and the dispatch
  pass resolves it to `evaluate`'s latest status

## MODIFIED Requirements

### Requirement: Prior-results accumulate across node executions

The runner SHALL maintain an ordered, run-wide array of structured
`NodeResult` entries — one entry per completed node execution,
appended in completion order at the moment the executor's event
stream drains and the node's terminal status is resolved. Each
entry SHALL have exactly the following shape:

```ts
{
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  reason: string | null;   // sentinel REASON when failed; null otherwise
  startedAt: number;       // ms since run start
  endedAt: number;         // ms since run start
  outputs: NodeOutputIndex | null;  // per the "NodeResult.outputs" requirement
  session_id: string | null;        // per the "Per-dispatch session id capture" requirement
}
```

When a node is scheduled, the runner SHALL pass a read-only, frozen
snapshot of the `priorResults` array through the executor's run
context as `ctx.priorResults`. Subsequent iterations of the same node
in a cycle SHALL therefore receive their own prior result entries
(and the entries of every other node that ran in between).

The `reason` field SHALL be populated from the executor's terminal
`status` event `meta` payload: when `meta.reason === "sentinel_failed"`
and `meta.sentinel` is a string, `reason` SHALL be that string
(trimmed of trailing whitespace). When the runner overrides a
node's terminal status to `failed` due to missing required outputs
(per the "Post-execution outputs validation" requirement),
`reason` SHALL be the string `missing_required_output`. When the
runner fails a dispatch before spawn because a declared `resume:`
target could not be resolved or the executor cannot resume (per the
"Cross-node session resume resolution" requirement), `reason` SHALL
be `resume_unavailable` or `resume_unsupported` respectively. In all
other cases (successful executions, non-sentinel non-output
failures), `reason` SHALL be `null`.

The `outputs` field SHALL be populated per the
"`NodeResult.outputs` field on prior results" requirement: the
`NodeOutputIndex` of present-and-satisfied outputs whatever the
node's terminal status; `null` when the node declared no `outputs:`
or none of its declared outputs were present.

The `session_id` field SHALL be populated per the "Per-dispatch
session id capture" requirement: the id announced by the dispatch's
`system` / `init` line, or `null` when no announcement was seen —
including for dispatches the runner failed before spawn.

Skipped nodes (those that hit the `max_iterations` budget at pop
time and were not actually dispatched to an executor) SHALL NOT
contribute an entry to `priorResults`.

The runner SHALL NOT pass the raw per-event run history through
the run context. The `onEvent` streaming consumer SHALL continue
to receive every event in real time, unchanged.

#### Scenario: Prior-results accumulate across nodes

- **WHEN** node A runs and completes with `succeeded` after
  emitting two stdout events, then node B is scheduled
- **THEN** the run context passed to B contains `priorResults`
  with exactly one entry: `{ nodeId: "A", iteration: 1,
  status: "succeeded", reason: null, startedAt: <ms>,
  endedAt: <ms>, outputs: null, session_id: <captured-id-or-null> }`
  (the `outputs` field defaults to `null` when A declared no outputs)

#### Scenario: A node's second iteration sees its first iteration's result

- **WHEN** node P runs (iteration 1) and succeeds, then node V
  runs and fails with a sentinel REASON of `"verify hit error"`,
  then the runner cycles back to P for iteration 2
- **THEN** the run context passed to P on iteration 2 contains
  `priorResults` with two entries in order: P iter 1 (status
  `succeeded`, `reason: null`, `outputs: null`), then V iter 1
  (status `failed`, `reason: "verify hit error"`,
  `outputs: null`) — neither node declared `outputs:`

#### Scenario: Prior-results snapshot is stable for the duration of a node run

- **WHEN** node A is running and node B (running concurrently in
  a future fan-out) completes
- **THEN** A's `priorResults` snapshot does not change mid-run;
  A sees only the entries that existed when it was scheduled.
  (v0 is single-flight, so this is trivially true; the rule is
  documented to bind future fan-out.)

#### Scenario: Non-sentinel failure records null reason

- **WHEN** a node that declares no `outputs:` fails via non-zero
  exit code with no `MINIFAC_STATUS:` sentinel in the final result
  event
- **THEN** the entry appended to `priorResults` has `status:
  "failed"`, `reason: null`, and `outputs: null`

#### Scenario: Missing-required-output override records the named reason

- **WHEN** a node declaring `findings` (required) and `notes`
  (optional) terminates `succeeded` at the executor layer having
  written only `notes.json`, and the outputs validator overrides it
  to `failed` because `findings` is missing
- **THEN** the entry appended to `priorResults` has `status:
  "failed"`, `reason: "missing_required_output"`, and `outputs`
  populated with the partial index `{ notes }` (the same index the
  failure event's `meta.partial_index` and the store carry)

#### Scenario: Sentinel-failed node with a parseable output records the index

- **WHEN** node `evaluate` declares
  `outputs: { result: { type: "value", required: true } }`, writes
  `result.json` containing `{"verdict":"revise"}`, and terminates
  `failed` with sentinel REASON `"revise: two criteria unmet"`
- **THEN** the entry appended to `priorResults` has `status:
  "failed"`, `reason: "revise: two criteria unmet"`, and `outputs`
  populated with the `result` entry (`type: "value"`, its absolute
  path, `size`, `mtime`)

#### Scenario: Successful execution with satisfied outputs records the index

- **WHEN** a node terminates `succeeded` with both required
  outputs satisfied
- **THEN** the entry appended to `priorResults` has `status:
  "succeeded"`, `reason: null`, and `outputs` populated with
  the `NodeOutputIndex` of present-and-satisfied keys

#### Scenario: Unresolvable resume records the named reason and a null session

- **WHEN** a node declaring `resume: plan` is failed before spawn
  because `plan` captured no session
- **THEN** the entry appended to `priorResults` has
  `status: "failed"`, `reason: "resume_unavailable"`,
  `outputs: null` (nothing was dispatched, so nothing landed), and
  `session_id: null`

#### Scenario: Skipped node is not appended

- **WHEN** node P has `max_iterations: 2` and has already
  executed twice, and the runner pops a third scheduled
  occurrence of P from its queue
- **THEN** the runner skips P without dispatch and SHALL NOT
  append a `priorResults` entry for that skipped occurrence

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

Validation SHALL run whenever the node declares an `outputs:`
block (per the `factory-schema` capability's "Node `outputs:`
block" requirement), whatever the node's resolved terminal status.
The terminal status decides what is **enforced**, not what is
**indexed**:

- When the node's resolved terminal status is `succeeded`
  (sentinel succeeded; non-sentinel exit-zero terminations also
  count), required outputs are enforced as described below (nudge
  loop, then terminal-status override).
- When the node's resolved terminal status is `failed` for any
  reason (sentinel failure, non-zero exit, executor error), the
  validator SHALL scan the outputs directory exactly once and
  populate the `NodeOutputIndex` with every present-and-satisfied
  output, and SHALL NOT enforce anything: the nudge loop is not
  entered, the node's terminal status and existing failure reason
  are preserved unchanged, and no `missing_required_output`
  override fires. When one or more `required: true` outputs are
  unsatisfied on a failed node, the runner SHALL emit a stderr
  event beginning `outputs_warning:` that names the node, the
  unsatisfied keys, the outputs directory and the keys that were
  indexed, followed by one stderr line per unsatisfied key carrying
  the validator's detail string; these events SHALL be persisted
  like any other stderr event. A failed node's `NodeResult.outputs`
  is populated per the "`NodeResult.outputs` field on prior
  results" requirement.

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

After scanning all declared outputs on a `succeeded` node, the
validator SHALL collect the keys whose `required: true` declaration
is unsatisfied (absent, present-but-invalid, present-but-ambiguous,
or present-but-empty). When that set is non-empty, the runner's
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
still be populated, persisted, and carried on the node's
`priorResults` entry even when the override fires; operators
inspecting the failed node can still see what the model did write,
and downstream nodes can still address it.

When all required outputs are satisfied (or none are required),
the node's existing terminal status is preserved unchanged and
the `NodeOutputIndex` is populated for every present output
(required and optional).

#### Scenario: Required value output landed via MCP passes

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`,
  the executor's `supportsMcp` is `true`, and during the
  dispatch the model calls `mcp__minifac__report_findings`
  with a valid payload
- **THEN** the bridge writes `<outputs_dir>/findings.json`; the
  validator finds it and parses it; the node's terminal status
  remains `succeeded`; the `NodeOutputIndex` for `propose`
  contains `findings` with `type: "value"`, `path` ending in
  `/findings.json`, and a positive `size`

#### Scenario: Required value output landed via Write fallback passes

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`,
  the executor's `supportsMcp` is `true`, the MCP tool was
  registered, but the model instead used its Write tool to
  create `<outputs_dir>/findings.json` with valid JSON
- **THEN** the validator finds and parses the file exactly as
  in the MCP case; the node's terminal status remains
  `succeeded`; the `NodeOutputIndex` is populated

#### Scenario: Required value output landed via filesystem-JSON on non-MCP executor

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`,
  the resolved executor's `supportsMcp` is `false`, and the
  model writes `<outputs_dir>/findings.json` via its Write tool
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

- **WHEN** node `evaluate` declares `outputs: { result:
  { type: "value", required: true } }`, writes
  `<outputs_dir>/result.json` containing valid JSON, and
  terminates `failed` with reason `"revise: two criteria unmet"`
  (sentinel failure)
- **THEN** the enforcing half of validation is skipped — the nudge
  loop is not entered and no override fires — and the node's
  terminal status remains `failed` with the sentinel reason
  preserved verbatim; the indexing half still runs:
  `NodeResult.outputs` contains
  `result` with `type: "value"`, its absolute path, `size` and
  `mtime`; the store's `recordNodeOutputs` receives the same
  index; no `outputs_warning` stderr event is emitted

#### Scenario: Failed-sentinel node missing a required output warns and preserves its reason

- **WHEN** node `verify` declares `outputs: { results:
  { type: "value", required: true } }`, writes nothing, and
  terminates `failed` with reason `"verify hit 3 test failures"`
- **THEN** the node's terminal status remains `failed` with the
  sentinel reason preserved verbatim (NOT
  `missing_required_output`); `NodeResult.outputs` is `null`;
  the runner emits a stderr event beginning
  `outputs_warning: node "verify" failed and is missing required outputs: results`
  naming the outputs directory, followed by the validator's
  detail line for `results`; no `status` event is re-emitted;
  the nudge loop is not entered

#### Scenario: Failed node with an unparseable value output warns and indexes the rest

- **WHEN** node `evaluate` declares `result` (required) and
  `notes` (optional) as `value` outputs, writes a `result.json`
  that is not valid JSON and a valid `notes.json`, and
  terminates `failed` with a sentinel reason
- **THEN** `NodeResult.outputs` contains `notes` only; the
  `outputs_warning` stderr event names `result` as unsatisfied,
  its detail line carries the JSON parse error, and the warning
  reports `indexed: notes`; the sentinel reason is preserved

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

### Requirement: `NodeResult.outputs` field on prior results

The runner SHALL extend the `NodeResult` shape (per the existing "Prior-results accumulate" requirement) with an `outputs` field whose value is one of:

- `NodeOutputIndex` — a `Record<string, NodeOutputEntry>` where
  each `NodeOutputEntry` has shape
  `{ type: "value" | "file" | "directory"; path: string;
  size: number; mtime: number }`. The map's keys are the
  declared output keys; entries are present only for outputs the
  validator determined were present-and-satisfied. The index is
  populated **whatever the node's terminal status**: a
  `succeeded` node, a node the validator overrode to `failed`
  for a missing required output (the partial index), and a node
  that terminated `failed` on its own (sentinel failure, non-zero
  exit, executor error) all carry the outputs that landed.
- `null` — when the node declared no `outputs:`, or when the
  validator found no present-and-satisfied outputs.

The field SHALL be added to the snapshot the runner passes
through the run context as `ctx.priorResults`. Downstream nodes
(in the same run) consume it via the `priorResults.<id>.outputs.<key>`
template token (per the modified "Brief token substitution"
requirement below), and can read the producing node's terminal
status via the `priorResults.<id>.status` token (per the
"Prior-result status and reason tokens" requirement) to decide how
to treat what they read.

#### Scenario: NodeResult carries outputs index on success

- **WHEN** node `propose` declares two satisfied value outputs
  and terminates `succeeded`
- **THEN** the `priorResults` entry for `propose` has `outputs`
  as a `NodeOutputIndex` containing both keys with `type`,
  `path`, `size`, `mtime` populated

#### Scenario: NodeResult carries outputs index on failure

- **WHEN** node `evaluate` declares `result` as a value output,
  writes a parseable `result.json`, and terminates `failed` with
  a sentinel reason
- **THEN** the `priorResults` entry for `evaluate` has `outputs`
  as a `NodeOutputIndex` containing `result`, and a downstream
  node reached via `on_failure` whose prompt contains
  `{{ priorResults.evaluate.outputs.result:read }}` receives the
  file's contents inline

#### Scenario: NodeResult.outputs is null on failure

- **WHEN** node `verify` declares outputs, writes none of them,
  and terminates `failed`
- **THEN** the `priorResults` entry for `verify` has
  `outputs: null`

#### Scenario: NodeResult.outputs is null when no outputs declared

- **WHEN** a node declares no `outputs:` block and terminates
  `succeeded`
- **THEN** the `priorResults` entry for that node has
  `outputs: null`
