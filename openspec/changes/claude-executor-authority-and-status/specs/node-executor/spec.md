## MODIFIED Requirements

### Requirement: Claude executor uses stream-json for both input and output

The `claude` executor SHALL spawn the `claude` CLI as a child process
with `--input-format stream-json` and `--output-format stream-json`. It
SHALL serialize the node's `prompt` (from `with:`) together with the run
history from `ctx` as stream-json input on the child's stdin. It SHALL
parse the CLI's stream-json output line-by-line, yielding each line as
an `stdout` event with the raw JSON line as its content. stderr from
the CLI SHALL be forwarded as `stderr` events. It SHALL respect the
node's resolved `cwd` if provided.

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

#### Scenario: Run history is sent on stdin as stream-json

- **WHEN** a `claude` node runs with a non-empty `ctx.history`
- **THEN** the executor writes a stream-json document to the child
  stdin that encodes the prior events (in order) plus the node's
  prompt, then closes stdin

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

## ADDED Requirements

### Requirement: Per-node authority controls in claude executor `with:`

The `claude` executor's `with:` schema SHALL accept three optional
fields that opt the node into broader CLI authority. The fields are
opt-in: when unset, the executor SHALL spawn the CLI without the
corresponding flags, preserving the pre-existing restrictive default
behavior.

- `permission_mode` (string): one of the literal values `"default"`,
  `"accept_edits"`, or `"bypass_permissions"`. When set, the executor
  SHALL pass `--permission-mode <value>` to the CLI.
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
- **THEN** the spawned argv contains `--permission-mode accept_edits`

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
- **THEN** the spawned argv contains `--permission-mode bypass_permissions`
  earlier in the argv than `--debug`

### Requirement: Status signaling via sentinel marker

The `claude` executor SHALL inspect the final stream-json `result`
event emitted by the CLI for a sentinel marker that lets the model
inside the spawned session communicate work-level success or failure to
the runner.

The sentinel format SHALL be a line within the `result` event's
`result` field (the final assistant message text) matching the regex:

```
/^MINIFAC_STATUS:\s*(succeeded|failed)\b\s*(?:\nREASON:\s*(.*))?/m
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

The executor SHALL NOT modify the prompt text to inject sentinel
instructions; prompt authoring is the factory's responsibility. The
wire-format comment block at the top of the executor source SHALL
document the sentinel contract.

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
