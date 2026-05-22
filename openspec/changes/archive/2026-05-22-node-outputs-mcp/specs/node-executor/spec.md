## ADDED Requirements

### Requirement: Executor `supportsMcp` capability flag

Every `NodeExecutor` SHALL expose a `readonly supportsMcp:
boolean` field on the executor interface. The flag declares
whether the executor's underlying runtime can connect to an
MCP server and invoke its tools.

The `claude` executor SHALL set `supportsMcp: true`.

Future executors that do not speak MCP SHALL set
`supportsMcp: false`. The runner consults this flag to decide
whether to:

- Register MCP tools for the dispatching node's declared
  `type: "value"` outputs (per the `graph-runner` capability's
  "Per-node MCP tool registration for `value` outputs"
  requirement);
- Emit a per-dispatch `.mcp.json` config file (per the
  `graph-runner` capability's "Per-dispatch `.mcp.json` config
  emission" requirement);
- Pass `--mcp-config <path>` to the executor's CLI invocation
  (per the modified "Claude executor uses stream-json for both
  input and output" requirement below, and per the analogous
  rules a future executor would carry).

The flag SHALL NOT control whether the per-run MCP server
starts. The server starts unconditionally per run (other nodes
in the same run may use it). It SHALL NOT control whether the
per-node outputs directory is created (it always is). It SHALL
NOT control whether the post-execution validator runs (it always
does, transport-agnostic).

#### Scenario: Claude executor declares MCP support

- **WHEN** the runner reads the registered `claude` executor's
  `supportsMcp` field
- **THEN** the field's value is `true`

#### Scenario: Non-MCP executor declares no MCP support

- **WHEN** a hypothetical future executor (e.g. a hand-rolled
  shell-out runner) is registered with `supportsMcp: false`
- **THEN** the runner SHALL NOT register MCP tools for nodes
  routed to that executor and SHALL NOT pass `--mcp-config`
  to the executor's CLI invocation; the executor's outputs
  flow through the filesystem-JSON fallback transport

#### Scenario: Field is part of the executor interface, not optional

- **WHEN** a developer registers a new executor that omits
  the `supportsMcp` field on the implementation
- **THEN** TypeScript's strict mode rejects the registration
  at compile time; the field is required on every
  `NodeExecutor` implementation

## MODIFIED Requirements

### Requirement: Claude executor uses stream-json for both input and output

The `claude` executor SHALL spawn the `claude` CLI as a child process
with `--input-format stream-json` and `--output-format stream-json`. It
SHALL serialize the node's `prompt` (from `with:`) together with the
`priorResults` array from `ctx` as stream-json input on the child's
stdin. It SHALL parse the CLI's stream-json output line-by-line,
yielding each line as an `stdout` event with the raw JSON line as its
content. stderr from the CLI SHALL be forwarded as `stderr` events. It
SHALL respect the node's resolved `cwd` if provided.

When the runner has emitted an `.mcp.json` config for the
current dispatch (per the `graph-runner` capability's
"Per-dispatch `.mcp.json` config emission" requirement) and
passed its path through `ctx.mcpConfigPath`, the executor
SHALL include `--mcp-config <abs-path>` in the CLI argv ahead
of any node-supplied flags. When `ctx.mcpConfigPath` is absent
or empty, the executor SHALL NOT include `--mcp-config` (the
existing flag set is unchanged).

The executor's terminal status SHALL be derived in the following
precedence order:

1. If the final stream-json `result` event's `result` field contains a
   sentinel matching `MINIFAC_STATUS:` followed by `succeeded` or
   `failed` (see the "Status signaling via sentinel marker" requirement),
   the sentinel determines the terminal status — overriding the CLI's
   exit code.
2. Otherwise, the child exit code determines the status: code `0`
   yields `succeeded`; any non-zero code yields `failed`. This
   preserves backwards-compatible behavior for prompts that do not opt
   into the sentinel.

In all cases, the `meta` field of the terminal status event SHALL carry
the raw child exit code under the key `exitCode` so debugging is
unambiguous when sentinel and exit code disagree.

#### Scenario: Prior results are sent on stdin as stream-json

- **WHEN** a `claude` node runs with a non-empty `ctx.priorResults`
- **THEN** the executor writes a single stream-json user-message line
  to the child stdin whose `message.content` is the JSON-serialized
  `priorResults` array followed by `\n\n---\n\n` and then the node's
  prompt, then closes stdin

#### Scenario: Empty prior results still framed as JSON array

- **WHEN** a `claude` node runs as the first node of a run (so
  `ctx.priorResults` is `[]`)
- **THEN** the user-message content sent to stdin starts with the
  literal `[]\n\n---\n\n` preamble before the prompt

#### Scenario: Prior-results JSON keys match the NodeResult shape

- **WHEN** the executor serializes a `priorResults` entry into the
  stdin preamble
- **THEN** the serialized object contains exactly the keys `nodeId`,
  `iteration`, `status`, `reason`, `startedAt`, `endedAt` with the
  values the runner provided in `ctx.priorResults`

#### Scenario: Streaming output appears event-by-event

- **WHEN** the `claude` CLI emits five stream-json messages during a run
- **THEN** the executor yields five distinct `stdout` events in order,
  one per message, as those messages arrive

#### Scenario: Non-zero exit yields failed status when no sentinel is present

- **WHEN** the `claude` CLI exits with code 1 and the final `result`
  event contains no `MINIFAC_STATUS:` marker
- **THEN** the executor's final event is `{ kind: "status",
  status: "failed", meta: { exitCode: 1, ... } }`

#### Scenario: Zero exit yields succeeded status when no sentinel is present

- **WHEN** the `claude` CLI exits with code 0 and the final `result`
  event contains no `MINIFAC_STATUS:` marker
- **THEN** the executor's final event is `{ kind: "status",
  status: "succeeded", meta: { exitCode: 0 } }`

#### Scenario: Missing CLI is reported clearly

- **WHEN** the `claude` binary is not on `$PATH`
- **THEN** the executor yields `{ kind: "status", status: "failed" }`
  with a message naming `claude` as the missing dependency

#### Scenario: Resolved cwd is honored

- **WHEN** a node declares `cwd: ./target-repo` in a factory at
  `/tmp/factories/foo.yaml`
- **THEN** the child `claude` process is spawned with cwd
  `/tmp/factories/target-repo`

#### Scenario: `--mcp-config` is passed when an MCP config path is in scope

- **WHEN** the runner dispatches a Claude node and
  `ctx.mcpConfigPath` is the absolute path
  `~/.minifac/outputs/abc.../propose/1/.mcp.json`
- **THEN** the spawned `claude` CLI argv includes
  `--mcp-config ~/.minifac/outputs/abc.../propose/1/.mcp.json`
  (with the home tilde expanded) ahead of any node-supplied
  flags

#### Scenario: `--mcp-config` is omitted when no path is in scope

- **WHEN** the runner dispatches a Claude node without an
  emitted `.mcp.json` (e.g. a unit-test invocation of the
  executor outside the runner)
- **THEN** the spawned `claude` CLI argv does not include
  `--mcp-config`; the existing argv is byte-identical to
  pre-change behavior
