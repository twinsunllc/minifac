---
change: node-outputs-mcp
factory: sdd
base_branch: main
depends_on:
  - node-outputs
---

## Background

[[0027-Node-Outputs]] ships outputs with a **filesystem-only
v1 transport**: the model writes JSON files for `type: value`
outputs at known paths. This works but has felt friction —
the model has to remember to write the file, schema
validation is post-hoc, and writes don't surface as
distinct events in the stream-json log.

The binding decision is at
`docs/decisions/0029-Node-Outputs-MCP.md`. Read it first.
Key calls already locked:

- Replace filesystem-JSON transport for `type: value`
  outputs with an inline MCP server exposing typed tools
  per declared output.
- `file` and `directory` outputs stay filesystem — MCP
  doesn't help when the natural shape is "files."
- One MCP server per run, on a unix socket under the
  per-run state directory.
- Tools generated dynamically per dispatching node, scoped
  to that node's declared outputs.
- Bridge to the filesystem layer: tool calls write to the
  same JSON paths used by `node-outputs`, so downstream
  consumers (templates, runs.db, CLI) keep working unchanged.

Depends on `node-outputs` having landed (transports plug into
its storage layout).

## What to do

### 1. MCP SDK dependency

- Add the official MCP TypeScript SDK as a dependency.
  Confirm the version is current and supported.
- Lock it via the `cli.yml` dep-freshness gate (it'll need
  to be > 3 days old).

### 2. Inline MCP server in the runner

Add `src/runner/mcp-server.ts` exposing:

```typescript
export interface RunnerMcpServer {
  socketPath: string;
  registerNodeOutputs(nodeId: string, outputs: ResolvedOutputs): void;
  clearNodeOutputs(nodeId: string): void;
  close(): Promise<void>;
}

export async function startRunnerMcpServer(
  runId: string,
  outputsRoot: string,
  onOutput: (nodeId: string, key: string, value: unknown) => void,
): Promise<RunnerMcpServer>;
```

Server lifecycle:

- Started once per run (in `runFactory` setup)
- Listens on a unix socket at `<outputs_root>/../mcp.sock`
- Stopped on run termination

### 3. Tool generation per node

When dispatching a node that declares `outputs:`, build an
MCP tool registration per `value` output:

```
mcp__minifac__report_<output-key>(value: <type-derived schema>)
```

The tool's input schema is derived from the declared output:

- `type: value` + array / object → `z.array(z.any())` /
  `z.object({}).passthrough()` (loose for v1; structural
  typing later)
- `type: value` + string / number / boolean → corresponding
  primitive
- `description` from the output declaration becomes the
  tool's description

Registrations happen at node dispatch time and are
de-registered at node termination. Each node sees only its
own outputs' tools.

### 4. `.mcp.json` and Claude CLI wiring

For each Claude-executor node dispatch:

- Write `.mcp.json` to a transient location (per-run,
  cleaned up at run termination):
  ```json
  {
    "mcpServers": {
      "minifac": {
        "type": "stdio",
        "command": "node",
        "args": ["<wrapper-script>", "--socket", "<socket-path>"]
      }
    }
  }
  ```
  (Or the equivalent socket-direct form if the MCP SDK
  supports it without a stdio wrapper.)
- Pass `--mcp-config <path>` on the Claude CLI invocation
  alongside the existing flags.

### 5. Bridge to storage

When a tool call lands at the server, the `onOutput`
callback:

1. Validates the payload against the declared schema
   (defensive double-check beyond what the SDK does)
2. Serializes to JSON
3. Writes `<outputs_dir>/<key>.json` (same path the v1
   filesystem transport used)
4. Updates the in-runner outputs index that
   `validateDeclaredOutputs()` reads in `node-outputs`'s
   validation pass

The validation pass from `node-outputs` is unchanged — it
just sees the JSON file land via MCP instead of via direct
model write.

### 6. Executor capability flag

Extend `NodeExecutor` in `src/executor/types.ts`:

```typescript
interface NodeExecutor {
  readonly type: string;
  readonly supportsMcp: boolean;
  // ...
}
```

Claude executor: `supportsMcp = true`. For other future
executors, set `false` and the runner falls back to the
filesystem transport from `node-outputs`.

### 7. Concept / docs updates

- Update `docs/concepts/Outputs.md` to describe both
  transports (filesystem fallback + MCP) and when each
  applies.
- Add a section to `docs/decisions/0024-CI-Security-Policy.md`
  acknowledging the new MCP SDK dependency in the
  verified-publisher discussion.
- Note the MCP socket path in `docs/Config.md` (it lives
  under the per-run state directory; not in `config.yaml`).

### 8. Tests

- MCP server starts on run setup; stops on run termination
- Tool generation matches declared outputs (presence,
  schema)
- Tool calls write to the expected JSON file paths
- Per-node scoping: node A sees only A's tools, never B's
- Malformed payloads (tool input schema fails) → tool call
  errors, model can retry
- Non-Claude executor falls back to filesystem transport
- Existing tests from `node-outputs` and
  `node-outputs-nudge` (if landed) continue to pass

### 9. Spec deltas

- MODIFY the `node-outputs` capability's "production"
  requirement to describe both transports
- Note the executor capability flag in the executor capability
  spec
- ADD MCP-specific scenarios

## Out of scope

- Schemaless `report_output(key, value)` tool — typed-per-
  output is the v1 default
- `attach_file_output` / `attach_directory_output`
  confirmation tools (the runner detects files on disk
  without them)
- Custom MCP tools beyond outputs reporting
- Cross-node tool visibility
- Pluggable MCP transport backends (only stdio / socket
  in v1)

## Acceptance criteria

- MCP SDK locked in `package.json` (and passes the dep-
  freshness CI gate)
- One MCP server starts per run, stops on termination
- Tools generated per node match declared `value` outputs
- Tool calls write to the same JSON paths used by
  `node-outputs`
- Validation pass from `node-outputs` succeeds for
  outputs delivered via MCP
- Claude CLI is invoked with `--mcp-config` pointing at
  the running server
- Non-MCP executors fall back to filesystem transport
- All existing tests pass; new tests cover the criteria
  above
- Docs reflect the dual-transport story
