## Why

The v1 outputs transport landed in `node-outputs` works but has
real friction: the model has to remember to write a JSON file at
a magic path, schema mismatches surface only post-hoc as
`missing_required_output`, and `value`-output writes are
invisible in the stream-json event log (they look like any other
`Write` tool call). `docs/decisions/0029-Node-Outputs-MCP.md`
binds the upgrade: replace the filesystem transport for
`type: value` outputs with an inline MCP server that exposes
typed tools generated per-node from the declared outputs. Tool
calls are stream-json events, fail loud in-context on schema
mismatch, and are idiomatic for Claude. `file` and `directory`
outputs stay filesystem-written — MCP doesn't help when the
natural shape is a file.

This change implements the MCP transport. Depends on
`node-outputs` having landed.

## What Changes

- **NEW** inline MCP server in the runner. One server per run,
  listening on a unix socket under the per-run state directory at
  `${MINIFAC_HOME}/outputs/<run-id>/../mcp.sock`. The server SHALL
  start at run setup and stop at run termination.
- **NEW** dynamic tool registration per dispatching node. For each
  declared `type: value` output on the currently-running node, the
  server SHALL expose a tool
  `mcp__minifac__report_<output-key>(value: <derived schema>)`.
  The tool's input schema is derived from the declared output's
  type and (future) shape; the tool's description comes from the
  declaration's `description`. Tools SHALL be registered at node
  dispatch and de-registered at node termination, scoped to the
  dispatching node so no other node can report on the dispatching
  node's behalf.
- **NEW** bridge to the v1 filesystem layer. When a tool call
  lands, the server SHALL validate the payload against the
  declared schema, serialize to JSON, write
  `<outputs_dir>/<key>.json` (the same path the v1 filesystem
  transport used), and update the in-runner tracking that the
  post-execution validator reads. The validator's behavior is
  unchanged — it just sees the JSON file land via MCP instead of
  via a direct model write.
- **NEW** `.mcp.json` config emitted per Claude-executor dispatch
  to a transient location under the per-run state directory,
  pointing at the running socket. The runner SHALL pass
  `--mcp-config <path>` on the `claude` CLI invocation alongside
  existing flags, and clean the file up at run termination.
- **NEW** `supportsMcp` capability flag on the executor interface.
  Executors with `supportsMcp: true` (Claude in v0) receive the
  MCP transport for `value` outputs; executors with
  `supportsMcp: false` fall back to the filesystem-JSON transport
  from `node-outputs` (the model writes `<key>.json` directly).
- **NEW** runtime dependency on the official MCP TypeScript SDK
  (`@modelcontextprotocol/sdk`), locked in `package.json` and
  subject to the dep-freshness gate from
  `docs/decisions/0024-CI-Security-Policy.md`.
- **NEW** concept doc updates: `docs/concepts/Outputs.md` grows a
  section on the dual transport (filesystem fallback + MCP) and
  when each applies; `docs/decisions/0024-CI-Security-Policy.md`
  acknowledges the new dep in its verified-publisher discussion;
  `docs/Config.md` notes the per-run MCP socket path.

## Capabilities

### New Capabilities

(none — keeping with the "no premature subsystems" anti-goal,
the MCP server lives inside the existing `graph-runner`
capability as a transport detail; the executor capability flag
attaches to `node-executor`.)

### Modified Capabilities

- `graph-runner`: ADD requirements for (a) per-run MCP server
  lifecycle, (b) per-node MCP tool registration / de-registration
  derived from declared `value` outputs, (c) the MCP-to-filesystem
  bridge that lands tool-call payloads at the same paths the v1
  transport used, (d) `.mcp.json` emission and cleanup;
  MODIFY the existing "Post-execution outputs validation"
  requirement to describe both transports (filesystem fallback
  and MCP) and the unchanged validator behavior across both.
- `node-executor`: ADD a `supportsMcp` capability flag on the
  executor interface; MODIFY the existing "Claude executor uses
  stream-json for both input and output" requirement to add the
  `--mcp-config <path>` argument to the CLI invocation when an
  MCP socket is in scope (i.e. when the executor's `supportsMcp`
  flag is true and the runner has started a server for the run).

## Impact

- `package.json` — add `@modelcontextprotocol/sdk` runtime
  dependency at the version current as of acceptance, locked via
  the existing dep-freshness CI gate (`cli.yml`).
- `src/runner/mcp-server.ts` (new) — the inline MCP server
  exposing the `RunnerMcpServer` interface; per-node tool
  registration / de-registration; payload validation; the
  `onOutput` bridge into the runner's in-memory outputs tracking.
- `src/runner/run.ts` — start the MCP server in `runFactory`
  setup once per run; register a node's tools at dispatch, deregister at
  termination; thread the server's `onOutput` callback to the
  runner's outputs-tracking state used by the post-execution
  validator; stop the server at run end; clean the transient
  `.mcp.json` file.
- `src/runner/mcp-config.ts` (new) — emit the per-dispatch
  `.mcp.json` file pointing at the run-scoped socket; resolve a
  cleanup-safe transient path under the per-run state directory.
- `src/executor/types.ts` — add `readonly supportsMcp: boolean`
  to the `NodeExecutor` interface.
- `src/executor/claude.ts` — set `supportsMcp = true`; when
  `ctx.mcpConfigPath` is present, append `--mcp-config <path>` to
  the CLI argv.
- `src/factory/schema.ts` — no schema changes; outputs declaration
  surface is unchanged.
- `src/storage/sqlite.ts` — no schema changes; `node_outputs`
  table still records what landed on disk regardless of transport.
- `docs/concepts/Outputs.md` — update to describe both transports.
- `docs/decisions/0024-CI-Security-Policy.md` — note the new
  MCP SDK dep in the verified-publisher section.
- `docs/Config.md` — note the per-run socket path lives in the
  per-run state directory; it is not a `config.yaml` field.
- Tests alongside each module per the project convention.

### Out of scope

- A schemaless `report_output(key, value)` MCP tool — typed-
  per-output tools are the v1 default (see ADR-0029 "Alternatives
  considered").
- `attach_file_output` / `attach_directory_output` MCP tools
  for confirmation of `type: file` / `type: directory` outputs —
  the runner detects files on disk without them.
- Custom MCP tools beyond outputs reporting.
- Cross-node tool visibility — a node SHALL see only its own
  declared outputs' tools.
- Pluggable MCP transport backends (e.g. HTTP) — socket / stdio
  via the SDK only in v1.
- Structural typing for `value` outputs beyond the type-derived
  loose schema (`array`, `object`, primitive). The `shape:` slot
  reserved by `node-outputs` is still accepted but the MCP layer
  treats `value` payloads with loose schemas in v1.
- Changes to the post-execution validator's behavior. It still
  scans `<outputs_dir>` after termination; MCP just lands files
  at the same paths the v1 transport did.
- Output-missing recovery / nudge logic (separate change
  `node-outputs-nudge`).
