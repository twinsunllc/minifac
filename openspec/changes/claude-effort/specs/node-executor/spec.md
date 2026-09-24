## ADDED Requirements

### Requirement: Optional per-node effort in claude executor `with:`

The `claude` executor's `with:` schema SHALL accept an optional string
field `effort`. The executor SHALL trim the value, then:

- when the trimmed value is empty, or the key is absent, the executor
  SHALL emit NO `--effort` flag, so the CLI applies its own default;
- when the trimmed value is one of `low`, `medium`, `high`, `xhigh` or
  `max`, the executor SHALL pass `--effort <value>` immediately after
  `--model` (or where `--model` would be) and BEFORE the authority flags
  and the `with.args` passthrough;
- any other value (including a non-string) SHALL be rejected with
  `invalid_with` meta and no child spawn.

The field is a string rather than an enum so a step can bind it from an
input (`effort: "{{ inputs.effort }}"`) and leave that input blank. The
schema SHALL remain strict.

#### Scenario: A listed level is passed through

- **WHEN** a `claude` node declares `with: { prompt: "hi", model: "m", effort: "high" }`
- **THEN** the argv contains `--model m --effort high` in that order,
  ahead of any authority flag and `with.args`

#### Scenario: Blank effort passes nothing

- **WHEN** a `claude` node declares `effort: ""` (or omits the key)
- **THEN** the argv contains no `--effort`, and is otherwise identical to
  the argv of the same node without the key

#### Scenario: An unknown level fails before spawn

- **WHEN** a `claude` node declares `effort: "turbo"`
- **THEN** the executor yields `{ kind: "status", status: "failed",
  meta: { reason: "invalid_with", ... } }` and spawns no child
