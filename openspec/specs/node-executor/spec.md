# node-executor Specification

## Purpose
TBD - created by archiving change core-graph-runner. Update Purpose after archive.
## Requirements
### Requirement: Executor interface

A node executor SHALL expose a stable identifier (its `type`, matching
the `executor` field in a node definition) and a `run(node, ctx)` method
that returns an async iterable of node events. Event kinds SHALL be
limited to `stdout`, `stderr`, and `status`. A `status` event of
`succeeded` or `failed` SHALL be the final event yielded for any given
node execution. The `ctx` argument SHALL include the run-wide
`priorResults` array (see graph-runner spec), the current node's
iteration count, and the resolved `cwd` for this node (factory-relative
paths resolved to absolute).

#### Scenario: Executor identifier matches node executor field

- **WHEN** a node declares `executor: claude`
- **THEN** the runner selects an executor whose `type` is `claude`; if no
  such executor is registered, the run fails before any node executes

#### Scenario: Final event is a terminal status

- **WHEN** an executor finishes running a node successfully
- **THEN** the last event it yields is `{ kind: "status",
  status: "succeeded" }`

#### Scenario: Failed execution yields failed status

- **WHEN** an executor encounters an unrecoverable error mid-run
- **THEN** it yields a final `{ kind: "status", status: "failed" }` event
  (after any partial `stdout`/`stderr` already emitted) and stops

### Requirement: Executor validates its own `with:` payload

Each executor SHALL validate the `with:` object passed to it and reject
unknown or malformed inputs before producing any output. Validation
errors SHALL be reported as a `failed` status event with a clear message.

#### Scenario: Claude executor rejects missing prompt

- **WHEN** a node with `executor: claude` has no `prompt` in `with:`
- **THEN** the executor yields `{ kind: "status", status: "failed",
  meta: <validation error> }` and produces no `stdout`

### Requirement: Claude executor uses stream-json for both input and output

The `claude` executor SHALL spawn the `claude` CLI as a child process
with `--input-format stream-json` and `--output-format stream-json`. It
SHALL serialize the node's `prompt` (from `with:`) together with the
`priorResults` array from `ctx` as stream-json input on the child's
stdin. It SHALL parse the CLI's stream-json output line-by-line,
yielding each line as an `stdout` event with the raw JSON line as its
content. stderr from the CLI SHALL be forwarded as `stderr` events. It
SHALL respect the node's resolved `cwd` if provided.

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

### Requirement: Executor registry

The runner SHALL maintain a registry of executors keyed by `type`. The
core registry SHALL ship with exactly one executor (`claude`) in v0.
Registering a second executor with the same `type` SHALL fail at
registration time.

#### Scenario: Duplicate registration fails

- **WHEN** code attempts to register two executors both reporting
  `type: "claude"`
- **THEN** registration throws before any factory is loaded

### Requirement: Per-node authority controls in claude executor `with:`

The `claude` executor's `with:` schema SHALL accept three optional
fields that opt the node into broader CLI authority. The fields are
opt-in: when unset, the executor SHALL spawn the CLI without the
corresponding flags, preserving the pre-existing restrictive default
behavior.

- `permission_mode` (string): one of the literal values `"default"`,
  `"accept_edits"`, or `"bypass_permissions"`. When set to
  `"accept_edits"` or `"bypass_permissions"`, the executor SHALL pass
  `--permission-mode <camelCase-value>` to the CLI, mapping snake_case
  YAML values to the CLI's camelCase choices: `accept_edits` →
  `acceptEdits`, `bypass_permissions` → `bypassPermissions`. The value
  `"default"` SHALL emit no `--permission-mode` flag, so the CLI's own
  default policy applies.
- `allowed_tools` (string array): each element a non-empty tool pattern.
  When set, the executor SHALL pass `--allowedTools <comma-joined-list>`
  to the CLI as a single flag whose value is the array joined by `,`.
- `add_dirs` (string array): each element a non-empty directory path.
  When set, the executor SHALL pass `--add-dir <dir>` once per element,
  in array order.

Validation rules:

- `permission_mode` SHALL be rejected with `invalid_with` meta if its
  value is not one of the three permitted literals.
- `allowed_tools` and `add_dirs` SHALL be rejected with `invalid_with`
  meta if any element is an empty string or not a string.
- The schema SHALL remain strict — unknown keys in `with:` are
  rejected, as today.

Flag ordering: when both new typed fields and the existing `with.args`
passthrough are set, the executor SHALL emit the typed flags first and
append `with.args` after them.

#### Scenario: Defaults emit no new flags

- **WHEN** a node sets only `prompt` in `with:`
- **THEN** the spawned `claude` CLI argv contains none of
  `--permission-mode`, `--allowedTools`, or `--add-dir`, and matches
  the pre-change wire format exactly

#### Scenario: `permission_mode` translates to `--permission-mode`

- **WHEN** a node sets `permission_mode: accept_edits`
- **THEN** the spawned argv contains `--permission-mode acceptEdits`
  (snake_case YAML value mapped to the CLI's camelCase choice)

#### Scenario: `permission_mode: default` emits no flag

- **WHEN** a node sets `permission_mode: default`
- **THEN** the spawned argv contains no `--permission-mode` flag, so the
  CLI's own default policy applies

#### Scenario: Unknown `permission_mode` is rejected

- **WHEN** a node sets `permission_mode: yolo`
- **THEN** the executor yields a final
  `{ kind: "status", status: "failed", meta: { reason: "invalid_with", ... } }`
  event and spawns no child process

#### Scenario: `allowed_tools` joins on comma

- **WHEN** a node sets `allowed_tools: ["Bash(openspec:*)", "Write"]`
- **THEN** the spawned argv contains exactly one
  `--allowedTools Bash(openspec:*),Write` flag

#### Scenario: Empty `allowed_tools` element is rejected

- **WHEN** a node sets `allowed_tools: ["Write", ""]`
- **THEN** the executor yields a final `failed` status with
  `meta.reason === "invalid_with"` and spawns no child process

#### Scenario: `add_dirs` repeats the flag

- **WHEN** a node sets `add_dirs: ["/tmp/x", "/tmp/y"]`
- **THEN** the spawned argv contains
  `--add-dir /tmp/x --add-dir /tmp/y` in that order

#### Scenario: Typed flags precede `with.args`

- **WHEN** a node sets `permission_mode: bypass_permissions` and
  `args: ["--debug"]`
- **THEN** the spawned argv contains `--permission-mode bypassPermissions`
  earlier in the argv than `--debug`

### Requirement: Status signaling via sentinel marker

The `claude` executor SHALL inspect the final stream-json `result`
event emitted by the CLI for a sentinel marker that lets the model
inside the spawned session communicate work-level success or failure to
the runner.

The sentinel format SHALL be a line within the `result` event's
`result` field (the final assistant message text) matching the regex:

```
/^MINIFAC_STATUS:[ \t]*(succeeded|failed)\b[ \t]*(?:\r?\nREASON:[ \t]*(.*))?/m
```

Behavior:

- If the captured status is `failed`, the executor SHALL yield a
  terminal `{ kind: "status", status: "failed", meta: { reason: "sentinel_failed", sentinel: <captured-reason-or-undefined>, exitCode: <code> } }`
  event, regardless of the child's exit code (including `0`).
- If the captured status is `succeeded`, the executor SHALL yield a
  terminal `{ kind: "status", status: "succeeded", meta: { reason: "sentinel_succeeded", exitCode: <code> } }`
  event, regardless of the child's exit code.
- If no marker matches in the final `result` event, the executor SHALL
  fall back to the exit-code-derived status described in the
  "Claude executor uses stream-json..." requirement.
- Only the *final* `result` event is inspected. Markers appearing in
  earlier assistant turns (e.g. mid-conversation tool-call planning)
  SHALL be ignored.

The executor SHALL auto-inject a canonical sentinel-emission
instruction block into the prompt it sends to the CLI, unless the
node opts out via the `emit_sentinel_instructions` knob (see below).
The injected block SHALL describe, in prose:

- the two acceptable trailing shapes — `MINIFAC_STATUS: succeeded` on
  success, and `MINIFAC_STATUS: failed` followed by `REASON: <one
  line>` on failure;
- that the marker must appear in the model's final assistant message;
- that the marker must be the last thing in the message.

The block SHALL be appended to the node's `prompt` (after a blank-line
separator) before the existing stream-json framing — the executor's
existing stdin envelope shape is unchanged; only the `prompt` field
the envelope wraps is extended.

The block's exact text is implementation, kept as a single named
constant in `src/executor/claude.ts` (so future format changes are a
one-line diff plus a deliberate snapshot update). The constant SHALL
be cross-referenced in the wire-format comment block at the top of
the same file.

The `emit_sentinel_instructions` field (see "Per-node sentinel-injection
opt-out in claude executor `with:`" requirement) defaults to `true`
when omitted. Setting it to `false` SHALL suppress the appended
block; the executor SHALL still scan the response for the sentinel
marker per the parse rules above. Parsing behavior is unaffected by
this knob.

#### Scenario: `MINIFAC_STATUS: failed` overrides exit 0

- **WHEN** the `claude` CLI exits with code `0` and its final `result`
  event's `result` field ends with `MINIFAC_STATUS: failed\nREASON: nothing got done`
- **THEN** the executor's final event is
  `{ kind: "status", status: "failed", meta: { reason: "sentinel_failed", sentinel: "nothing got done", exitCode: 0 } }`

#### Scenario: `MINIFAC_STATUS: succeeded` is honored

- **WHEN** the `claude` CLI exits with code `0` and the final `result`
  event's `result` field contains a line `MINIFAC_STATUS: succeeded`
- **THEN** the executor's final event is
  `{ kind: "status", status: "succeeded", meta: { reason: "sentinel_succeeded", exitCode: 0 } }`

#### Scenario: Absent sentinel falls back to exit code

- **WHEN** the `claude` CLI exits with code `0` and no `MINIFAC_STATUS:`
  marker appears in any stream-json event
- **THEN** the executor's final event is
  `{ kind: "status", status: "succeeded", meta: { exitCode: 0 } }` —
  identical to the pre-change behavior

#### Scenario: Sentinel in an earlier assistant turn is ignored

- **WHEN** an assistant message earlier in the stream contains
  `MINIFAC_STATUS: failed` but the final `result` event does not
- **THEN** the executor SHALL NOT treat the run as sentinel-failed and
  SHALL apply exit-code-derived semantics

#### Scenario: Default-on injection appears in constructed prompt

- **WHEN** a node sets only `prompt: "do X"` in `with:` and the
  executor builds its stream-json stdin payload
- **THEN** the constructed payload's user-message content contains the
  bare prompt followed by the canonical sentinel-emission instruction
  block — the block's text is byte-identical to the named constant
  exported from `src/executor/claude.ts`

#### Scenario: Injected block describes both success and failure shapes

- **WHEN** the executor's auto-injected sentinel-emission block is
  inspected
- **THEN** it names the two literal trailing shapes
  (`MINIFAC_STATUS: succeeded` and `MINIFAC_STATUS: failed` followed
  by `REASON: <one line>`) and instructs the model that the marker
  must be the last thing in its final assistant message

### Requirement: Per-node sentinel-injection opt-out in claude executor `with:`

The `claude` executor's `with:` schema SHALL accept an optional boolean
field `emit_sentinel_instructions`. The field defaults to `true` when
omitted. When `true` (or omitted), the executor SHALL auto-append the
canonical sentinel-emission instruction block to the outgoing prompt
per the "Status signaling via sentinel marker" requirement. When
`false`, the executor SHALL send the prompt verbatim, with no appended
block.

Validation rules:

- The field SHALL be a boolean. Any non-boolean value SHALL be
  rejected with `meta: { reason: "invalid_with", ... }` per the
  existing strict-schema validation behavior.
- The schema SHALL remain strict — unknown keys in `with:` are
  rejected as today.

The opt-out knob SHALL NOT change response-side parse behavior. The
executor SHALL continue to scan the final stream-json `result` event
for the sentinel marker regardless of this field's value.

#### Scenario: Default omitted field auto-injects the block

- **WHEN** a node sets `prompt: "do X"` in `with:` and omits
  `emit_sentinel_instructions`
- **THEN** the executor's constructed stdin payload contains the
  bare prompt followed by the canonical sentinel-emission
  instruction block

#### Scenario: Explicit `true` auto-injects the block

- **WHEN** a node sets `prompt: "do X"` and
  `emit_sentinel_instructions: true` in `with:`
- **THEN** the executor's constructed stdin payload contains the
  bare prompt followed by the canonical sentinel-emission
  instruction block — identical to the omitted-field case

#### Scenario: Explicit `false` suppresses the appended block

- **WHEN** a node sets `prompt: "do X"` and
  `emit_sentinel_instructions: false` in `with:`
- **THEN** the executor's constructed stdin payload's user-message
  content is exactly the bare prompt (history preamble plus
  separator plus prompt, with no appended sentinel block)

#### Scenario: Non-boolean value is rejected

- **WHEN** a node sets `emit_sentinel_instructions: "yes"` in `with:`
- **THEN** the executor yields a final
  `{ kind: "status", status: "failed", meta: { reason: "invalid_with", ... } }`
  event and spawns no child process

#### Scenario: Opt-out does not disable response-side sentinel parsing

- **WHEN** a node sets `emit_sentinel_instructions: false` and the
  spawned child's final `result.result` field nonetheless contains
  `MINIFAC_STATUS: failed\nREASON: opted out anyway`
- **THEN** the executor's final event is
  `{ kind: "status", status: "failed", meta: { reason: "sentinel_failed", sentinel: "opted out anyway", exitCode: <code> } }` —
  parsing applies regardless of injection

