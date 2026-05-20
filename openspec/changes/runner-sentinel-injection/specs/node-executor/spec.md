## MODIFIED Requirements

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

## ADDED Requirements

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
