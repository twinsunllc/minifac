---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0029: MCP transport for `value` outputs

## Context

[[0027-Node-Outputs]] specifies the outputs feature with a
**filesystem-based v1 transport**: the model writes JSON
files to `<outputs_dir>/<key>.json` for `type: value` outputs.
This works, ships value, and avoids any new runtime machinery.

But it has felt friction:

- The model has to *remember* to write a file at the right
  path with the right filename. Easy to forget, slightly
  awkward.
- Schema validation happens only after the node terminates.
  If the model writes a malformed payload, the runner catches
  it *post hoc* and routes to the nudge / failure path —
  expensive compared to catching the error at production
  time.
- The filesystem write is not visible in the stream-json
  event log. The TUI / web viewer see only a `tool_use(Write)`
  event for `findings.json`, not a structured "output
  reported" event.

Claude Code natively supports **MCP (Model Context Protocol)**
servers, where the runner can expose typed tools the model
invokes directly. Tool calls are:

- **Stream-json events.** Visible in real time in every
  consumer of the runner's `onEvent` callback (TUI, viewer,
  runs.db).
- **Typed at call time.** The MCP tool's input schema
  rejects malformed payloads before they reach the runner.
- **Idiomatic for the model.** Tool calls are how Claude is
  trained to interact with the outside world — vs. writing
  a JSON file at a magic path, which is a bespoke convention.
- **Failure-loud.** A failed tool call returns an error in
  the model's working context; the model self-corrects on
  the next turn, often without needing the
  [[0028-Node-Outputs-Nudge|nudge]] mechanism.

This ADR replaces the filesystem transport for `value`
outputs with an MCP transport. `file` and `directory` outputs
stay filesystem — those are inherently file-shaped.

## Decision

For `type: value` outputs, the runner exposes an inline MCP
server with tools generated dynamically from the node's
declared outputs. The model calls the tools to report outputs;
the runner persists them to the same filesystem location and
`runs.db` index established in [[0027-Node-Outputs]].

### Architecture

For each run, the runner:

1. Starts an inline MCP server on a unix socket at
   `<outputs_dir>/../mcp.sock`. (The socket lives in the
   per-run state directory; one server per run, not per
   node.)
2. Generates an `.mcp.json` config file pointing at the
   socket.
3. Invokes the Claude CLI with `--mcp-config <path>`.
4. Stops the server when the run terminates.

### Tools — generated per node

When a node with declared outputs runs, the MCP server
exposes tools whose schemas match the declarations:

```
mcp__minifac__report_findings(value: { issues: array, ... })
mcp__minifac__report_summary(value: string)
```

Where `findings` and `summary` are the declared `value`
output keys for the currently-running node. The tools'
input schemas are derived from each output's declared
`type` and (future) shape constraints.

A node sees only its own outputs' tools — not the tools for
other nodes' outputs. Tool generation happens at node
dispatch time, not run start.

### Bridge to the filesystem layer

When a tool call lands, the runner:

1. Validates the payload against the declared schema (MCP
   layer enforces this too; runner double-checks for
   defense-in-depth).
2. Serializes the payload to JSON.
3. Writes it to `<outputs_dir>/<key>.json` — the **same
   location** the v1 filesystem transport used.
4. Updates the in-memory tracking that drives
   [[0027-Node-Outputs|0027]]'s post-execution validation.

This means downstream consumers — template substitution,
runs.db queries, `minifac runs cat`, the validation pass —
all keep working unchanged. MCP is a transport upgrade,
not a storage rearchitecture.

### File and directory outputs are unchanged

`type: file` and `type: directory` outputs stay filesystem-
written by the model using its existing tools (Write, Edit).
MCP doesn't help here — files are already files. The runner's
existence-check at termination still validates these.

(A future ADR could add `attach_file_output(key, filename)` /
`attach_directory_output(key)` MCP tools as confirmation
hooks, but they're not load-bearing — the runner can detect
files on disk without them.)

### Fallback for non-Claude executors

The MCP transport assumes the executor supports MCP. v0
ships only the Claude executor, which does. When other
executors are added later, the engine falls back to the v1
filesystem transport for executors without MCP support.

The `executor` interface gains a capability flag:

```typescript
interface NodeExecutor {
  readonly type: string;
  readonly supportsMcp: boolean;
  // ...
}
```

Executors with `supportsMcp: true` get the MCP transport;
others use filesystem.

## Consequences

- **Better ergonomics for the dominant executor.** Claude
  uses tool calls naturally; the model rarely forgets to
  use a tool it's been instructed to use, especially with
  the tool description front and center.
- **Real-time visibility.** Tool calls stream through as
  `tool_use` events. The TUI and web viewer get a live
  "outputs reported" indication per node, in the right
  position in the event timeline.
- **Schema enforcement at call time.** Malformed payloads
  fail loudly in-context; the model self-corrects on the
  next turn without needing the runner-level nudge.
- **Cross-executor story preserved.** The filesystem
  fallback keeps non-MCP executors working with the same
  storage layout and consumer-side APIs.
- **One new runtime dep: an MCP SDK.** The TypeScript
  reference SDK is small and stable.

## Alternatives considered

- **Keep filesystem-only.** Works, ships value with
  [[0027-Node-Outputs]], no new dep. Rejected because the
  ergonomic gap is real — the model forgets writes more
  often than it forgets tool calls.
- **Custom JSON-RPC over stdio (no MCP).** Rejected — MCP
  is the standard. Claude Code already supports it. Building
  a parallel protocol would be wheel-reinvention.
- **HTTP transport (scarif's pattern).** Rejected — HTTP is
  the right transport for [[0017-Callback-Status-Signaling]]'s
  bidirectional intervention surface, but for one-way
  structured payloads from the model, MCP is the model-native
  affordance.
- **Generate tools at run-start, expose all nodes' tools to
  all nodes.** Rejected — would let an upstream node "report
  outputs" for a downstream node, which is gibberish. Per-
  node tool exposure scopes the affordance correctly.
- **Schemaless MCP tools (`report_output(key, value)`).**
  Considered. Rejected for v1 — typed tools give the model a
  stronger signal about what shape is expected. The
  schemaless form could come later as a "free-form output"
  affordance, but typed is the right default.

## Open questions

- What's the right SDK / library? The official MCP TypeScript
  SDK is the leading candidate; alternative is hand-rolling
  the protocol (overkill).
- Socket vs stdio? Socket is cleaner for the
  one-server-per-run model; stdio would require multiplexing.
  Leaning socket.
- How do we surface the MCP server's events alongside
  executor events? The runner's `onEvent` callback already
  handles multi-source streaming; the MCP server's
  tool-call-received events get tagged with the originating
  node ID.

## Related

- [[0027-Node-Outputs]] — establishes the outputs surface
  this ADR upgrades
- [[0028-Node-Outputs-Nudge]] — recovery loop; less load on
  the nudge once tool-call schema enforcement is at call
  time
- [[0017-Callback-Status-Signaling]] — sibling transport for
  the bidirectional intervention surface; intentionally
  separate
