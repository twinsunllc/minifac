## ADDED Requirements

### Requirement: Executor `supportsResume` capability flag

Every `NodeExecutor` SHALL expose a `readonly supportsResume:
boolean` field on the executor interface. The flag declares whether
the executor's underlying runtime can continue a previously started
session identified by an opaque session id, rather than starting a
fresh one.

The `claude` executor SHALL set `supportsResume: true`.

Executors that cannot continue a prior session SHALL set
`supportsResume: false`. The runner consults this flag when a
dispatching node declares `resume:` (per the `graph-runner`
capability's "Cross-node session resume resolution" requirement) and
fails such a dispatch before spawn when the flag is `false`.

The flag SHALL NOT affect dispatches of nodes that declare no
`resume:`, and SHALL NOT control session-id capture — the runner
captures a dispatch's announced session id regardless of the flag's
value, so that a run's `node_executions` rows carry the join key for
every executor that announces one.

#### Scenario: Claude executor declares resume support

- **WHEN** the runner reads the registered `claude` executor's
  `supportsResume` field
- **THEN** the field's value is `true`

#### Scenario: Non-resuming executor declares no resume support

- **WHEN** a future executor whose runtime has no session concept is
  registered with `supportsResume: false` and a node routed to it
  declares `resume: <node-id>`
- **THEN** the runner fails that dispatch before spawn with
  `meta.reason === "resume_unsupported"`; nodes routed to the same
  executor that declare no `resume:` are dispatched normally

#### Scenario: Field is part of the executor interface, not optional

- **WHEN** a developer registers a new executor that omits the
  `supportsResume` field on the implementation
- **THEN** TypeScript's strict mode rejects the registration at
  compile time; the field is required on every `NodeExecutor`
  implementation

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

When the runner has resolved a session id for the current dispatch
(per the `graph-runner` capability's "Cross-node session resume
resolution" requirement) and passed it through
`ctx.resumeSessionId`, the executor SHALL include
`--resume <session-id>` in the CLI argv, positioned after
`--mcp-config` and BEFORE `--model`, the authority flags, and the
`with.args` passthrough. When `ctx.resumeSessionId` is absent or
empty, the executor SHALL NOT include `--resume`, and the argv SHALL
be byte-identical to pre-change behavior.

`--resume` and `--model` SHALL be emitted together when both are in
scope: continuing a session on a different model is the intended
composition, and the executor SHALL NOT suppress, reorder, or warn
about either flag on that basis. The executor SHALL NOT validate the
session id or the model id against any local state — an unreadable
session or an unknown model surfaces as a non-zero child exit code
through the ordinary exit-code path.

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
- **THEN** the serialized object contains exactly the keys of the
  `NodeResult` shape defined by the `graph-runner` capability's
  "Prior-results accumulate across node executions" requirement —
  `nodeId`, `iteration`, `status`, `reason`, `startedAt`, `endedAt`,
  `outputs`, `nudges_used`, `session_id` — with the values the runner
  provided in `ctx.priorResults`. The executor SHALL NOT filter or
  reshape the entries: the preamble mirrors the shape verbatim, so a
  future field on `NodeResult` appears without an executor change

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

#### Scenario: `--resume` is passed when a session id is in scope

- **WHEN** the runner dispatches a Claude node with
  `ctx.resumeSessionId === "abc-123"`
- **THEN** the spawned `claude` CLI argv includes
  `--resume abc-123`, positioned after any `--mcp-config` pair and
  before `--model`, the authority flags, and `with.args`

#### Scenario: `--resume` is omitted when no session id is in scope

- **WHEN** the runner dispatches a Claude node whose resolved node
  declares no `resume:` (so `ctx.resumeSessionId` is absent)
- **THEN** the spawned argv contains no `--resume` flag and is
  byte-identical to pre-change behavior

#### Scenario: `--resume` and `--model` compose for a model cascade

- **WHEN** the runner dispatches a Claude node with
  `ctx.resumeSessionId === "abc-123"` and `with: { model: "cheap-model" }`
- **THEN** the spawned argv contains both `--resume abc-123` and
  `--model cheap-model`, with `--resume` earlier in the argv; the
  executor emits no warning and suppresses neither flag

#### Scenario: Unreadable session surfaces as a non-zero exit

- **WHEN** the runner dispatches a Claude node with
  `ctx.resumeSessionId === "gone-999"` and the CLI exits non-zero
  because it cannot read that session
- **THEN** the executor's final event is
  `{ kind: "status", status: "failed", meta: { exitCode: <non-zero>, ... } }`;
  the executor performs no local validation of the session id and
  emits no resume-specific failure reason
