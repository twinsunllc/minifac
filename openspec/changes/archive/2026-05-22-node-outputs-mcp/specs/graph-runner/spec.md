## ADDED Requirements

### Requirement: Per-run MCP server lifecycle

The runner SHALL start exactly one inline MCP server per run,
listening on a unix socket at
`${MINIFAC_HOME}/outputs/<run-id>/../mcp.sock` (equivalently a
sibling of the per-run outputs tree), where `<run-id>` is the
run id minted at run start (per the existing
"Per-node-per-iteration outputs directory" requirement, including
the UUID-shaped fallback when no store is in scope). The runner
SHALL create the parent directory before binding the socket.

The server SHALL be started in `runFactory` setup, before any
node is dispatched, and SHALL be stopped at run termination
(success or failure) in the same lifecycle block that closes
the run's store. Stopping the server SHALL close the socket and
remove the socket file from disk.

The server SHALL be implemented using the official MCP
TypeScript SDK (`@modelcontextprotocol/sdk`). Hand-rolling the
JSON-RPC framing is out of scope. The SDK version SHALL be
locked in `package.json` and SHALL be subject to the existing
dep-freshness CI gate.

#### Scenario: Server starts before any node dispatch

- **WHEN** `runFactory` is invoked for a factory whose first
  node is `propose`
- **THEN** the MCP socket at
  `${MINIFAC_HOME}/outputs/<run-id>/../mcp.sock` exists and is
  accepting connections before `propose` is dispatched

#### Scenario: Server stops on successful run termination

- **WHEN** a run completes successfully (all nodes terminate
  with `succeeded`, the runner exits its scheduling loop, and
  the store is closed)
- **THEN** the MCP socket is closed and the socket file is
  removed from disk before `runFactory` returns

#### Scenario: Server stops on failed run termination

- **WHEN** a run terminates because a node failed and the
  factory has no recovery edge from the failed node
- **THEN** the MCP socket is closed and the socket file is
  removed from disk before `runFactory` returns the failed
  result

#### Scenario: Server stops on uncaught exception

- **WHEN** an exception is thrown mid-run (e.g. the store
  rejects an insert)
- **THEN** the runner's `finally` block closes the MCP socket
  and removes the socket file even though `runFactory` is
  rethrowing the exception

#### Scenario: Concurrent runs use distinct sockets

- **WHEN** two runs with distinct run ids `aaa...` and `bbb...`
  execute concurrently in the same process
- **THEN** each run binds a distinct socket file at its own
  `${MINIFAC_HOME}/outputs/<run-id>/../mcp.sock` path; tool
  calls from one run never reach the other run's server

### Requirement: Per-node MCP tool registration for `value` outputs

The runner SHALL register one MCP tool per `type: "value"`
declared output of the dispatching node with the run's MCP
server before the executor is invoked, when (and only when) the
resolved executor's `supportsMcp` flag is `true` (per the
`node-executor` capability's "Executor `supportsMcp` capability
flag" requirement) and the node's declared `outputs:` block
contains one or more `type: "value"` entries.

Tool naming and shape:

- Tool name: literal `mcp__minifac__report_<key>`, where
  `<key>` is the declared output key verbatim.
- Tool description: the declared output's `description` field
  if present and non-empty; otherwise the string
  `"Report the <key> output for this node."` (where `<key>` is
  substituted verbatim).
- Tool input schema: derived from the declared `OutputDef.shape`
  (if present) per the schema-derivation rules below; otherwise
  a permissive schema accepting any JSON-serializable value.

Schema derivation rules (v1, loose):

- When `shape` describes an array (e.g. `{ items: ... }` form
  or `shape: "array"`), the input schema SHALL accept any
  array value: `array(unknown)`.
- When `shape` describes an object (e.g. `{ fields: ... }` form
  or `shape: "object"`), the input schema SHALL accept any
  object value: `object({}).passthrough()`.
- When `shape` describes a primitive (`"string"`, `"number"`,
  `"boolean"`), the input schema SHALL accept that primitive.
- When `shape` is absent, the input schema SHALL accept any
  JSON-serializable value (`unknown`).

The runner SHALL NOT register tools for `type: "file"` or
`type: "directory"` outputs. Those remain filesystem-written by
the model's existing tools.

At node termination (after the executor's event stream drains
and before the post-execution validator runs), the runner SHALL
de-register every tool it registered for that node. The next
dispatched node SHALL see only its own outputs' tools, never
the prior node's.

When the resolved executor's `supportsMcp` flag is `false`, the
runner SHALL skip MCP tool registration entirely for the node;
the node falls back to the filesystem-JSON transport per the
"Post-execution outputs validation (dual transport)" modified
requirement.

#### Scenario: Tools registered for declared `value` outputs

- **WHEN** the runner is about to dispatch node `propose` whose
  declared outputs are
  `{ findings: { type: "value", required: true }, summary: { type: "value" } }`,
  and the executor's `supportsMcp` is `true`
- **THEN** before the executor is invoked, the MCP server has
  two tools registered for this node:
  `mcp__minifac__report_findings` and
  `mcp__minifac__report_summary`

#### Scenario: Tool description sources from declaration

- **WHEN** a declared output is
  `findings: { type: "value", description: "Code review findings as an array of issue objects." }`
- **THEN** the registered MCP tool's description is exactly
  `"Code review findings as an array of issue objects."`

#### Scenario: Tool description falls back to a generic form

- **WHEN** a declared output is
  `notes: { type: "value" }` (no `description`)
- **THEN** the registered MCP tool's description is exactly
  `"Report the notes output for this node."`

#### Scenario: Tool input schema accepts arrays when shape implies array

- **WHEN** a declared output is
  `findings: { type: "value", shape: { items: "array" } }`
- **THEN** the registered MCP tool's input schema accepts any
  JSON array (the tool call succeeds with `value: []` and with
  `value: [{ ... }, { ... }]`)

#### Scenario: Tool input schema accepts objects when shape implies object

- **WHEN** a declared output is
  `summary: { type: "value", shape: { fields: { foo: "string" } } }`
- **THEN** the registered MCP tool's input schema accepts any
  JSON object (the tool call succeeds with `value: {}` and with
  `value: { foo: "bar", extra: 42 }`)

#### Scenario: No tools registered for file outputs

- **WHEN** a node declares
  `{ patch: { type: "file", filename: "patch.diff" } }`
- **THEN** no MCP tool is registered for `patch`; the model
  writes the file at `<outputs_dir>/patch.diff` using its
  existing Write tool (unchanged from `node-outputs`)

#### Scenario: No tools registered for directory outputs

- **WHEN** a node declares
  `{ logs: { type: "directory" } }`
- **THEN** no MCP tool is registered for `logs`; the model
  writes files into `<outputs_dir>/logs/` using its existing
  tools (unchanged from `node-outputs`)

#### Scenario: Per-node tool scoping — node B does not see node A's tools

- **WHEN** node A (with output `findings: { type: "value" }`)
  has terminated, the runner has de-registered A's tools, and
  node B (with output `summary: { type: "value" }`) is now
  dispatching
- **THEN** the MCP server exposes exactly
  `mcp__minifac__report_summary`; calling
  `mcp__minifac__report_findings` from B returns an MCP
  "unknown tool" error

#### Scenario: Tools de-registered at node termination

- **WHEN** node `propose` terminates (its executor's event
  stream drains)
- **THEN** every tool the runner registered for `propose` is
  de-registered before the post-execution validator runs; a
  late tool call arriving after de-registration returns an MCP
  "unknown tool" error

#### Scenario: No tool registration when executor lacks MCP support

- **WHEN** the runner is about to dispatch a node whose
  resolved executor declares `supportsMcp: false` and whose
  declared outputs include `findings: { type: "value", required: true }`
- **THEN** no MCP tool is registered for `findings`; the runner
  still creates the per-node outputs directory and runs the
  post-execution validator against the filesystem-JSON
  transport per the modified validation requirement

### Requirement: MCP-to-filesystem bridge for `value` output tool calls

The runner's MCP bridge SHALL persist every successful
`report_<key>` tool call to the dispatching node's outputs
directory before returning to the model.

When an MCP `report_<key>` tool call lands at the running
server, the bridge SHALL:

1. Validate the payload against the declared output's input
   schema (defensive double-check beyond the SDK's own
   enforcement). A schema mismatch SHALL return an MCP error
   to the model naming the output key and the validation
   failure detail; the tool call SHALL NOT touch disk.
2. Serialize the validated payload to JSON using stable
   formatting: `JSON.stringify(payload, null, 2)` with sorted
   object keys.
3. Write the serialized JSON to
   `<outputs_dir>/<key>.tmp-<random>.json` first, then rename
   to `<outputs_dir>/<key>.json` atomically (same-directory
   rename — guaranteed same-filesystem). A torn write SHALL
   never leave a half-formed `<key>.json` visible to the
   validator.
4. Update the runner's in-memory per-dispatch outputs tracking
   to mark `<key>` as "reported via MCP" with the bytes
   written. This tracking is a hint consumed by the
   post-execution validator and SHALL NOT be the source of
   truth; the validator's on-disk pass remains authoritative.
5. Return an MCP success response to the model containing the
   absolute path of the written file.

Repeated tool calls for the same `<key>` within a single node
dispatch SHALL overwrite the prior file atomically — the latest
write wins. The bridge SHALL NOT reject repeated calls;
operators have legitimate reasons to revise a payload
mid-dispatch.

The bridge SHALL NOT write outputs for the wrong node. The
runner SHALL ensure tool calls land in the dispatching node's
`<outputs_dir>` by construction — the tool registration is
parameterized at registration time with the resolved outputs
directory path.

#### Scenario: Tool call writes to the declared JSON path

- **WHEN** the model calls
  `mcp__minifac__report_findings({ value: [{ severity: "high" }] })`
  during the dispatch of node `propose` iteration 1 in run
  `abc...`
- **THEN** the bridge writes
  `~/.minifac/outputs/abc.../propose/1/findings.json` with the
  serialized JSON of the payload's `value` field

#### Scenario: Atomic rename leaves no partial files on failure

- **WHEN** the bridge writes the temp sibling
  `<outputs_dir>/findings.tmp-<random>.json` but the process
  crashes before the rename completes
- **THEN** no `<outputs_dir>/findings.json` exists when the
  validator later scans the directory (only the orphan
  `.tmp-*` file, which the validator's glob does not match);
  the validator treats the output as absent

#### Scenario: Schema mismatch returns an MCP error without touching disk

- **WHEN** the model calls
  `mcp__minifac__report_summary({ value: 42 })` for an output
  declared `shape: { fields: { ... } }` (object-shaped)
- **THEN** the bridge returns an MCP error to the model naming
  `summary` and the schema mismatch; no
  `<outputs_dir>/summary.json` is written

#### Scenario: Repeated calls overwrite atomically

- **WHEN** the model calls `mcp__minifac__report_findings`
  twice during one node dispatch — first with `{ value: [] }`,
  then with `{ value: [{ id: 1 }] }`
- **THEN** `<outputs_dir>/findings.json` exists and contains
  the second payload's JSON; the validator sees one
  present-and-parseable value output

#### Scenario: Tool call lands in the dispatching node's outputs dir

- **WHEN** node `propose` iteration 1 dispatches and calls
  `mcp__minifac__report_findings`
- **THEN** the file is written under
  `<outputs_root>/<run-id>/propose/1/`, not under any other
  node's outputs directory; even if a tool registration leak
  occurred (a defensive impossibility), no other directory
  could be targeted because the path is bound at registration
  time

### Requirement: Per-dispatch `.mcp.json` config emission

The runner SHALL emit a transient `.mcp.json` file at
`<outputs_dir>/.mcp.json` inside the per-node outputs directory
before dispatching the node, when the resolved executor's
`supportsMcp` flag is `true`. The file's contents SHALL
configure the MCP client to connect to the run's socket via the
SDK's stdio or socket-direct transport — whichever the SDK
supports without a wrapper script.

The file SHALL be emitted before the executor is invoked and
SHALL be cleaned up (deleted from disk) at run termination
alongside the socket close. Per-node deletion before the run
ends is NOT required — the file lives inside the per-node
outputs directory, which itself is governed by the existing
`prune --outputs` lifecycle from `node-outputs`.

The runner SHALL pass `--mcp-config <abs-path-to-.mcp.json>` on
the Claude CLI invocation (per the modified "Claude executor
uses stream-json for both input and output" requirement in the
`node-executor` capability). For executors with
`supportsMcp: false`, the runner SHALL NOT emit `.mcp.json`
and SHALL NOT pass `--mcp-config`.

#### Scenario: `.mcp.json` exists before dispatch

- **WHEN** the runner is about to dispatch node `propose`
  iteration 1 to a Claude executor (`supportsMcp: true`) in
  run `abc...`
- **THEN** the file
  `~/.minifac/outputs/abc.../propose/1/.mcp.json` exists and
  references the run's socket before the Claude CLI is spawned

#### Scenario: `.mcp.json` not emitted for non-MCP executor

- **WHEN** the runner is about to dispatch a node to an
  executor whose `supportsMcp` is `false`
- **THEN** no `.mcp.json` is emitted for that dispatch; the
  CLI invocation (if any) does not receive `--mcp-config`

#### Scenario: `.mcp.json` removed on run termination

- **WHEN** a run terminates (success or failure)
- **THEN** all `.mcp.json` files emitted by the runner during
  the run are removed from disk before `runFactory` returns;
  the per-node outputs directories themselves remain (subject
  to `prune --outputs`)

## MODIFIED Requirements

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
present-but-empty). If that set is non-empty, the validator SHALL
override the node's terminal status:

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
  to aid the operator in diagnosing the gap.

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
  `findings.json` via Write, and the node terminates
  `succeeded`
- **THEN** the validator overrides the terminal status to
  `failed` with reason `missing_required_output`; the
  `missing_outputs_detail` string mentions both the
  un-called MCP tool name (`mcp__minifac__report_findings`)
  and the absent fallback file (`findings.json`)

#### Scenario: Required value output absent on non-MCP executor records simple detail

- **WHEN** node `propose` declares
  `outputs: { findings: { type: "value", required: true } }`,
  the executor's `supportsMcp` is `false`, the model did not
  write `findings.json`, and the node terminates `succeeded`
- **THEN** the validator overrides the terminal status to
  `failed` with reason `missing_required_output`; the
  `missing_outputs_detail` string names the absent file
  without referencing MCP (the transport was not in scope)

#### Scenario: Required file output absent fails the node

- **WHEN** node `apply` declares `outputs: { patch:
  { type: "file", filename: "patch.diff", required: true } }`,
  terminates `succeeded`, and `<outputs_dir>/patch.diff` does
  not exist (MCP does not apply to file outputs)
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["patch"]`

#### Scenario: Required directory output empty fails the node

- **WHEN** node `verify` declares `outputs: { logs:
  { type: "directory", required: true } }`, terminates
  `succeeded`, and `<outputs_dir>/logs/` exists but contains
  no files (MCP does not apply to directory outputs)
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
  reason preserved verbatim; `NodeResult.outputs` is `null`

#### Scenario: Validator ignores orphan MCP temp files

- **WHEN** an interrupted MCP write left
  `<outputs_dir>/findings.tmp-abc123.json` on disk but
  `<outputs_dir>/findings.json` does not exist
- **THEN** the validator treats `findings` as absent (the
  `.tmp-*` orphan does not match the `<key>.json` filename);
  the validation outcome is the same as if the orphan file
  did not exist

#### Scenario: Optional output present via MCP is indexed

- **WHEN** a node declares `notes:
  { type: "value", required: false }`, the executor is
  MCP-capable, and the model calls
  `mcp__minifac__report_notes({ value: "ok" })` so the bridge
  writes `<outputs_dir>/notes.json`
- **THEN** the node succeeds; the `NodeOutputIndex` carries
  `notes: { type: "value", path, size, mtime }` just as it
  would for a filesystem-written optional output

#### Scenario: Override preserves the partial index across transports

- **WHEN** node `propose` declares two outputs `findings:
  { type: "value", required: true }` and `summary:
  { type: "value", required: false }`, the executor is
  MCP-capable, the model called
  `mcp__minifac__report_summary({ value: "ok" })` but never
  reported `findings`, and the node terminates `succeeded`
- **THEN** the validator overrides the terminal status to
  `failed` with reason `missing_required_output` and metadata
  `missing_outputs: ["findings"]`; the `NodeOutputIndex` still
  carries `summary: { type: "value", path, size, mtime }`
