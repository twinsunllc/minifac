## MODIFIED Requirements

### Requirement: Node definition

Each node SHALL declare an `executor` (string identifying a registered
runner, e.g. `claude`). It MAY declare `terminal` (boolean, default
`false`), `max_iterations` (positive integer), `cwd` (string),
`with` (free-form object passed verbatim to the executor),
`outputs` (see the "Node `outputs:` block" requirement),
`output_nudge_budget` (see the "`output_nudge_budget` per-node
field" requirement), and `resume` (see the "Node `resume:` field"
requirement).

A node MAY alternatively declare `uses:` + `inputs:` instead of
inline `executor:` + `with:` (see the "Node `uses:` field as an
alternative to inline executor" requirement). The accepted
node-level key set is: `executor`, `with`, `uses`, `inputs`,
`terminal`, `max_iterations`, `cwd`, `outputs`,
`output_nudge_budget`, `resume`. Any other key SHALL be rejected
with an error naming the offending key and the node id.

Nodes that declare `uses:` MAY also declare `outputs:`, and the
loader SHALL preserve a declared `outputs:` through step inlining
unchanged. A `uses:` node that declares no `outputs:` SHALL carry
its step's `outputs:`, when the step declares one (see the "Node
`uses:` field as an alternative to inline executor" requirement
and ADR 0054). The `output_nudge_budget` and `resume` fields SHALL
be preserved through step inlining unchanged; the step body has no
opinion on them.

#### Scenario: Node without executor fails validation

- **WHEN** a node definition is missing the `executor` key
- **THEN** validation fails with an error identifying the node id and the
  missing field

#### Scenario: Unknown top-level node keys are rejected

- **WHEN** a node defines a key not in the schema envelope (e.g. `retry`)
- **THEN** validation fails. (Executor-specific keys belong under `with:`.)

#### Scenario: `with:` is opaque to the schema

- **WHEN** a node declares `with: { prompt: "hello" }`
- **THEN** the schema accepts the node regardless of `with` contents;
  per-executor validation of `with` happens inside the executor

#### Scenario: Node declares `outputs:` alongside `executor:` + `with:`

- **WHEN** a node declares `executor: claude`, `with: { prompt: "..." }`,
  and `outputs: { findings: { type: "value", required: true } }`
- **THEN** the schema accepts the node; the resolved node carries
  the `outputs` map verbatim

#### Scenario: Node declares `outputs:` alongside `uses:` + `inputs:`

- **WHEN** a node declares `uses: minifac:openspec-propose`,
  `inputs: { change: "foo" }`, and
  `outputs: { plan: { type: "file", filename: "plan.md" } }`
- **THEN** the schema accepts the node; after step inlining the
  resolved node carries the `outputs` map verbatim alongside the
  inlined `executor` and `with`

#### Scenario: Node declares `output_nudge_budget` alongside `outputs:`

- **WHEN** a node declares `executor: claude`,
  `with: { prompt: "..." }`,
  `outputs: { findings: { type: "value", required: true } }`,
  and `output_nudge_budget: 1`
- **THEN** the schema accepts the node; the resolved node
  carries `output_nudge_budget: 1`

#### Scenario: Node declares `resume` alongside the other node-level fields

- **WHEN** a node declares `executor: claude`,
  `with: { prompt: "...", model: "cheap-model" }`,
  `max_iterations: 3`, and `resume: plan`
- **THEN** the schema accepts the node; the resolved node carries
  `resume: "plan"` alongside the other node-level fields

### Requirement: `OutputDef` discriminated types

Each value in a node's `outputs:` map SHALL be a discriminated
union on the `type` field, with three accepted values:

- **`type: "value"`** — a JSON-encoded value the model writes to
  `<outputs_dir>/<key>.json`. The schema SHALL accept the
  following sibling fields: `required` (boolean, default
  `false`), `description` (optional string), and `shape`
  (optional, value reserved for future structural typing —
  the schema accepts any value here today and the runtime
  validator ignores it; this reservation lets factory authors
  add structural typing in a future change without rewriting
  the factory), and `schema` (optional JSON Schema, draft
  2020-12, an object or a boolean). When `schema` is present
  the runtime validator SHALL validate the parsed value against
  it at node completion (`graph-runner` "Output schema
  validation at node completion"). `shape` and `schema` are
  independent; neither is derived from the other.
- **`type: "file"`** — a file the model writes inside
  `<outputs_dir>`. The schema SHALL accept: `required`
  (boolean, default `false`), `description` (optional string),
  `filename` (optional string). When `filename:` is present, it
  SHALL be a non-empty string with no path separators (i.e.
  the file lives at the top of `outputs_dir`). When absent,
  the validator at runtime discovers the file by globbing
  `<key>.*` inside `outputs_dir`.
- **`type: "directory"`** — a directory the model populates at
  `<outputs_dir>/<key>/`. The schema SHALL accept: `required`
  (boolean, default `false`), `description` (optional string).

Each `OutputDef` SHALL be strict on extras within its branch:
fields not listed above SHALL be rejected with an error naming
the offending key, the output key, and the node id.

A `type` value other than the three listed SHALL be rejected
with an error listing the supported types.

#### Scenario: `type: "value"` with all optional fields loads

- **WHEN** the loader reads a node with output `findings:
  { type: "value", required: true, description: "code review
  findings" }`
- **THEN** validation succeeds; the resolved output carries all
  three fields

#### Scenario: `type: "value"` with reserved `shape:` field accepted

- **WHEN** the loader reads a node with output `findings:
  { type: "value", shape: { items: "array" } }`
- **THEN** validation succeeds; the resolved output carries
  `shape` verbatim (the runtime validator ignores it today;
  the reservation is documented in the design)

#### Scenario: `type: "file"` with explicit filename loads

- **WHEN** the loader reads a node with output `patch:
  { type: "file", filename: "patch.diff", required: true }`
- **THEN** validation succeeds; the resolved output carries the
  filename

#### Scenario: `type: "file"` with filename containing a path separator is rejected

- **WHEN** the loader reads a node with output `patch:
  { type: "file", filename: "sub/patch.diff" }`
- **THEN** validation fails with an error naming the node id,
  the output key, and the `filename` field

#### Scenario: `type: "file"` with empty filename is rejected

- **WHEN** the loader reads a node with output `patch:
  { type: "file", filename: "" }`
- **THEN** validation fails with an error naming the node id,
  the output key, and the `filename` field

#### Scenario: `type: "directory"` loads with description

- **WHEN** the loader reads a node with output `logs:
  { type: "directory", required: false, description: "test
  output logs" }`
- **THEN** validation succeeds

#### Scenario: Unknown `type` is rejected

- **WHEN** the loader reads a node with output `x:
  { type: "blob" }`
- **THEN** validation fails with an error listing the supported
  types (`value`, `file`, `directory`)

#### Scenario: Unknown sibling field within an OutputDef branch is rejected

- **WHEN** the loader reads a node with output `findings:
  { type: "value", maxBytes: 1024 }` (where `maxBytes` is not
  in the value-branch schema)
- **THEN** validation fails with an error naming the node id,
  the output key, and the offending field name

#### Scenario: Output `required` defaults to false

- **WHEN** the loader reads a node with output `findings:
  { type: "value" }` (no `required:` declared)
- **THEN** the resolved output carries `required: false`

#### Scenario: `type: "value"` with a JSON Schema loads

- **WHEN** the loader reads a node with output `result:
  { type: "value", schema: { type: object, required: [verdict] } }`
- **THEN** validation succeeds; the resolved output carries
  `schema` verbatim

#### Scenario: An invalid JSON Schema is a load error naming the file

- **WHEN** the loader reads a factory or `extends:` layer whose
  node declares output `result: { type: "value", schema:
  { type: strng } }`, or a schema with an unknown keyword
- **THEN** loading fails with a `FactoryLoadError` whose
  `sourcePath` is that factory or layer file and whose message
  names `nodes.<id>.outputs.result.schema` and begins the detail
  with `invalid JSON Schema:`

#### Scenario: `schema:` on a non-value output is rejected

- **WHEN** the loader reads a node with output `patch:
  { type: "file", schema: {} }`
- **THEN** validation fails as for any unknown sibling field

### Requirement: Node `uses:` field as an alternative to inline executor

A factory node MAY declare a `uses:` field whose value SHALL be a non-empty string conforming to the `step-schema` capability's reference syntax (one of `minifac:<name>`, `<scope>/<name>[@<version>]`, or bare `<name>[@<version>]`). When a node declares `uses:`, it SHALL NOT also declare `executor:` — the two patterns are mutually exclusive on a single node, and the loader SHALL reject a node that declares both. A node that declares `uses:` MAY also declare a `with:` whose only key is `secrets`, whose value SHALL be a list. The loader SHALL copy that list, unchanged and in order, into the inlined step's `with` as `with.secrets`. Beside `uses:`, the loader SHALL reject, with a `FactoryLoadError` whose message is one sentence naming the node id: a `with:` holding any key other than `secrets` (alone or beside `secrets`); an empty `with: {}`; a `with:` that is not a mapping; and a `with.secrets` that is not a list. When the node declares `with.secrets` and the step's own `with` already declares `secrets`, the loader SHALL reject the node with a one-sentence `FactoryLoadError` naming the node id and the step, whether or not the two lists are equal; it SHALL NOT override or union them. The loader SHALL NOT validate the list's entries; their shape belongs to the consumer that reads `with.secrets`, as it does for an inline node.

A node with `uses:` MAY declare an `inputs:` field whose value SHALL be a flat object mapping input names (strings) to input values. The input values supply concrete values for the step's declared inputs; they are validated against the step's input schema at load time (see "Step input validation against the step's declared schema" requirement).

Node-level fields not specific to executor selection — `terminal`, `max_iterations`, `cwd`, `output_nudge_budget`, `resume`, and any future per-position fields — SHALL remain on the node regardless of whether the node uses inline `executor:` + `with:` or `uses:` + `inputs:`. These fields describe the node's position in the graph, not the step's behavior.

`outputs` describes what the step produces, so the step MAY declare it (`step-schema` "Step-declared outputs"). A `uses:` node that declares `outputs:` SHALL keep exactly its own map; a `uses:` node that declares none SHALL carry the step's whole `outputs:` map, schemas included, on the resolved node. The two maps SHALL NOT be merged. Under `extends:`, a derived layer that redeclares a node replaces it whole ("Replace-at-node-level merge semantics"), so a redeclared `uses:` node without `outputs:` carries its step's outputs, never the base node's; a node the derived layer does not redeclare keeps the base layer's node as resolved (ADR 0054). A step `outputs:` that fails validation SHALL surface as a `FactoryLoadError` naming the factory file and the step path.

The factory schema SHALL remain strict on extras at the node level. The accepted node-level key set is: `executor`, `with`, `uses`, `inputs`, `terminal`, `max_iterations`, `cwd`, `outputs`, `output_nudge_budget`, `resume`. Any other key SHALL be rejected with an error naming the offending key and the node id.

#### Scenario: Node with `uses:` and no `inputs:` loads

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-propose` and no `inputs:` block, and the step's declared inputs all have defaults or are optional
- **THEN** the loader returns the factory with the node's `uses:` reference resolved and the step inlined; the node has `executor` and `with` after inlining and no `uses:` / `inputs:` fields on the resolved node

#### Scenario: Node with `uses:` and `inputs:` loads

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-propose` and an `inputs:` block mapping each of the step's required inputs to a value
- **THEN** the loader returns the factory with the node's step resolved and inlined; the node has `executor` and `with` after inlining and no `uses:` / `inputs:` fields on the resolved node

#### Scenario: Node with both `uses:` and `executor:` is rejected

- **WHEN** the loader reads a node that declares both `uses: minifac:foo` and `executor: claude`
- **THEN** validation fails with an error naming the node id and explaining the mutual-exclusion rule

#### Scenario: Node with `uses:` and a `with:` key other than `secrets` is rejected

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and `with: { permission_mode: "bypass_permissions" }`, or `with: { prompt: "y" }`, or `with: { secrets: [A], model: "z" }`
- **THEN** validation fails with a one-sentence `FactoryLoadError` naming the node id, the offending key, and the mutual-exclusion rule

#### Scenario: Node with `uses:` and `with: { secrets }` loads with the list merged (local step)

- **WHEN** the loader reads a node that declares `uses: <local step>` and `with: { secrets: [A, { name: B, via: proxy }] }`, and the step's `with` declares no `secrets`
- **THEN** the resolved node's `with.secrets` deep-equals `[A, { name: B, via: proxy }]`, the step's other `with` keys are unchanged, and the resolved node has no `uses:` / `inputs:` fields

#### Scenario: Node with `uses:` and `with: { secrets }` loads with the list merged (library step)

- **WHEN** the loader reads, in a project that pins a library, a node that declares `uses: <library step>` and `with: { secrets: [...] }`
- **THEN** the resolved node's `with.secrets` deep-equals the declared list and the library step's other `with` keys are unchanged

#### Scenario: Node `with.secrets` refused when the step already declares `secrets`

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and `with: { secrets: [A] }`, and step `foo`'s own `with` declares `secrets` (equal to `[A]` or not)
- **THEN** validation fails with a one-sentence `FactoryLoadError` naming the node id and the step; nothing is overridden or unioned

#### Scenario: Malformed `with:` beside `uses:` is rejected

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and `with: {}`, or `with: { secrets: "A" }`, or a `with:` that is not a mapping
- **THEN** validation fails with an error naming the node id

#### Scenario: Node with `inputs:` but no `uses:` is rejected

- **WHEN** the loader reads a node that declares an `inputs:` block but no `uses:` field (and inline `executor:` + `with:` instead)
- **THEN** validation fails with an error naming the node id and explaining that `inputs:` is only valid alongside `uses:`

#### Scenario: Node with neither `uses:` nor `executor:` is rejected

- **WHEN** the loader reads a node that declares neither `uses:` nor `executor:`
- **THEN** validation fails with an error naming the node id and the missing-required-field

#### Scenario: Node with empty `uses:` string is rejected

- **WHEN** the loader reads a node whose `uses:` field is the empty string
- **THEN** validation fails with an error naming the node id and the `uses` field

#### Scenario: Node `uses:` of non-string type is rejected

- **WHEN** the loader reads a node whose `uses:` field is a list, map, number, or boolean
- **THEN** validation fails with an error naming the node id and the `uses` field's invalid type

#### Scenario: Node-level fields stay on node alongside `uses:`

- **WHEN** the loader reads a node that declares `uses: minifac:openspec-archive`, `terminal: true`, and `cwd: "{{ run.cwd }}"`
- **THEN** the resolved node carries `terminal: true` and `cwd: "{{ run.cwd }}"` after step inlining; these fields are not affected by the step's resolved body

#### Scenario: `resume:` stays on the node alongside `uses:`

- **WHEN** the loader reads a node that declares `uses: minifac:openspec-apply` and `resume: propose`
- **THEN** the resolved node carries `resume: "propose"` after step inlining; the inlined step body is byte-identical to the body the same step produces for a node that declares no `resume:`

#### Scenario: Unknown node-level key is still rejected

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and an unknown key like `retry:`
- **THEN** validation fails with an error naming the offending key and the node id

#### Scenario: Inline node without `uses:` continues to load unchanged

- **WHEN** the loader reads a factory whose nodes all declare inline `executor:` + `with:` (no `uses:` field anywhere)
- **THEN** the loader returns the factory with each node carrying `executor` and `with` exactly as declared; the loader performs no step resolution and the resolved factory is byte-equivalent to today's pre-change behavior

#### Scenario: A `uses:` node without `outputs:` inherits the step's

- **WHEN** the loader reads a node `uses: minifac:judge` with no
  `outputs:`, and step `judge` declares `outputs: { result: { type:
  value, required: true, schema: {...} } }`
- **THEN** the resolved node's `outputs` deep-equals the step's map

#### Scenario: A `uses:` node's own `outputs:` wins wholesale

- **WHEN** the same node declares `outputs: { report: { type: file } }`
- **THEN** the resolved node's `outputs` is exactly `{ report: ... }`;
  no `result` key

#### Scenario: A redeclared node under `extends:` takes the step's outputs

- **WHEN** a base layer declares node `judge` with `uses: minifac:judge`
  and its own `outputs:`, and a derived layer redeclares `judge` with
  `uses: minifac:judge` and no `outputs:`
- **THEN** the resolved `judge` carries step `judge`'s outputs; a node
  the derived layer does not redeclare keeps the base node's outputs

#### Scenario: A step with an invalid schema fails the factory load

- **WHEN** the loader reads a factory whose `uses:` step declares an
  invalid `outputs.result.schema`
- **THEN** loading fails with a `FactoryLoadError` whose `sourcePath` is
  the factory file and whose message names the step path
