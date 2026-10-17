## ADDED Requirements

### Requirement: Output schema validation at node completion

When a `type: value` output declares `schema:` (`factory-schema`
"`OutputDef` discriminated types"), the outputs validator SHALL, after
parsing `<outputs_dir>/<key>.json`, validate the parsed value against the
schema (JSON Schema draft 2020-12; ADR 0054). A value that does not match
SHALL NOT be indexed and SHALL NOT count as missing, whether or not the
output is `required`. An absent or unparseable value is handled exactly
as before ("Post-execution outputs validation").

On a node whose resolved terminal status is `succeeded`:

- When any required output is missing, the `missing_required_output`
  override applies unchanged (status `failed`, outcome `error`); it takes
  precedence over a mismatch.
- Otherwise, when any value output mismatches its schema, the runner SHALL
  set the node's status to `failed` and its outcome to `failure`, so it
  routes by `on_failure` edges and never by `on_error`. Its reason SHALL be
  `output_schema_mismatch: output "<key>" at <pointer>: <keyword>
  (<message>)` for the first violation, where `<pointer>` is the JSON
  pointer into the value, rendered as `(root)` when it is the root. Each
  violation's pointer SHALL be an RFC 6901 JSON pointer, the empty string
  for the root, wherever it is carried as data. The runner SHALL emit a
  stderr line beginning `output_schema_mismatch:` naming the node, the
  mismatched keys and the outputs directory, one stderr line per
  violation, and a `status` event with status `failed`, outcome
  `failure` and `meta` holding `reason: "output_schema_mismatch"`,
  `mismatched_outputs`, `schema_errors`, `outputs_dir` and
  `partial_index`. Each SHALL be persisted like any other event, and
  runs.db SHALL record outcome `failure`.

On a node whose resolved terminal status is `failed`, a mismatch SHALL NOT
change its status, outcome or reason; the runner SHALL emit an
`outputs_warning:` stderr line naming the mismatched keys, followed by one
line per violation.

A mismatch SHALL NOT trigger the nudge loop. A node with no `schema:` on
any output SHALL behave exactly as before.

#### Scenario: A matching value succeeds

- **WHEN** a node whose `result` declares `schema: { type: object,
  required: [verdict], properties: { verdict: { enum: [pass, fail] } } }`
  succeeds having written `{"verdict": "pass"}`
- **THEN** the node succeeds with outcome `success`, routes `on_success`,
  and `NodeResult.outputs.result` is indexed

#### Scenario: A mismatching value is a failure naming pointer and keyword

- **WHEN** the same node succeeds having written `{"verdict": "maybe"}`,
  and it declares both `on_failure` and `on_error` edges
- **THEN** the node ends `failed` with outcome `failure`, its reason
  begins `output_schema_mismatch: output "result" at /verdict: enum`, it
  routes `on_failure` only, and runs.db records outcome `failure`

#### Scenario: A missing required output wins

- **WHEN** a node with a schema'd required output succeeds without
  writing it
- **THEN** the node ends `failed` with outcome `error` and reason
  `missing_required_output`

#### Scenario: A failed node keeps its own reason

- **WHEN** a node fails with its own reason having written a value that
  violates its schema
- **THEN** the node keeps its status, outcome and reason, the value is not
  indexed, and an `outputs_warning:` stderr line lists the violation
