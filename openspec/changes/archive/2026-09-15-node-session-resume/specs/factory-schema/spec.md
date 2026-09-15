## ADDED Requirements

### Requirement: Node `resume:` field

A factory node MAY declare an optional `resume:` field whose value
SHALL be a non-empty string naming another node in the same factory.
The field declares that this node continues the named node's most
recent `claude` conversation instead of starting a fresh one; the
runtime resolution and failure semantics are the `graph-runner`
capability's responsibility (see its "Cross-node session resume
resolution" requirement).

The field is a node-level (topology) concern, not an executor payload.
It SHALL be accepted alongside inline `executor:` + `with:` AND
alongside `uses:` + `inputs:`, and the loader SHALL preserve it
through step inlining unchanged — on the same independence basis as
`outputs` and `output_nudge_budget`. The step body has no opinion on
which sibling node a factory chooses to resume.

The loader SHALL validate `resume:` against the **resolved** factory
(after `extends:` chain resolution and step inlining, before the run
starts) with the following rules:

- **Declared target.** The value MUST name a node id present in the
  resolved factory's `nodes` map. An unknown id SHALL be rejected
  with an error naming the declaring node id, the offending value,
  and the source location.
- **No self-resume.** The value MUST NOT equal the declaring node's
  own id. Self-resume SHALL be rejected with an error naming the node
  id; resuming a node's own prior iteration is a distinct feature and
  is not part of this capability.
- **Matching `cwd`.** The target node's declared `cwd` string MUST be
  identical to the declaring node's declared `cwd` string; both
  omitting `cwd` counts as identical. Comparison is on the declared
  (pre-substitution) string. A mismatch SHALL be rejected with an
  error naming both node ids and both `cwd` values, because sessions
  are scoped per project directory and a mismatched pair can never
  resolve at runtime.

The loader SHALL NOT check graph reachability between the declaring
node and its resume target. The graph is directed with cycles
first-class, so "the target always runs first" is not statically
decidable; an unreachable target is a runtime failure per the
`graph-runner` capability, not a load error.

The factory schema SHALL remain strict on extras at the node level;
`resume` joins the accepted node-level key set (see the "Node
definition" requirement).

#### Scenario: Node declares `resume:` alongside `executor:` + `with:`

- **WHEN** the loader reads a factory whose node `apply` declares
  `executor: claude`, `with: { prompt: "...", model: "cheap-model" }`,
  and `resume: plan`, and a node `plan` is declared with the same
  (omitted) `cwd`
- **THEN** the loader returns a typed factory object without error;
  the resolved `apply` node carries `resume: "plan"` verbatim

#### Scenario: Node declares `resume:` alongside `uses:` + `inputs:`

- **WHEN** the loader reads a factory whose node `apply` declares
  `uses: minifac:openspec-apply`, `inputs: { change: "foo" }`, and
  `resume: propose`
- **THEN** the loader resolves and inlines the step; the resolved
  `apply` node carries the inlined `executor` and `with` alongside
  `resume: "propose"` — the step's body is unchanged by the presence
  of `resume:`

#### Scenario: `resume:` naming an undeclared node is rejected

- **WHEN** the loader reads a factory whose node `apply` declares
  `resume: explore` and no node `explore` exists in the resolved
  factory
- **THEN** validation fails with an error naming the declaring node
  id (`apply`), the offending value (`explore`), and the source
  location

#### Scenario: Self-resume is rejected

- **WHEN** the loader reads a factory whose node `apply` declares
  `resume: apply`
- **THEN** validation fails with an error naming the node id and
  explaining that a node cannot resume itself

#### Scenario: Mismatched `cwd` between node and resume target is rejected

- **WHEN** the loader reads a factory whose node `plan` declares
  `cwd: "{{ run.cwd }}"` and whose node `apply` declares
  `cwd: "/other/repo"` and `resume: plan`
- **THEN** validation fails with an error naming both node ids and
  both `cwd` values, explaining that a resumed session is scoped to
  the project directory it was started in

#### Scenario: Identical omitted `cwd` on both nodes is accepted

- **WHEN** the loader reads a factory in which neither `plan` nor
  `apply` declares a `cwd`, and `apply` declares `resume: plan`
- **THEN** validation succeeds; both nodes resolve their cwd
  identically at run time

#### Scenario: `resume:` of a non-string or empty value is rejected

- **WHEN** the loader reads a factory whose node declares `resume:`
  as an empty string, a list, a map, a number, or a boolean
- **THEN** schema validation fails with an error naming the node id
  and the `resume` field's invalid value or type

#### Scenario: Resume target that runs later in the graph loads without error

- **WHEN** the loader reads a factory whose node `apply` declares
  `resume: verify` where the only edge into `verify` originates at
  `apply` (so `verify` cannot have run before `apply`'s first
  iteration)
- **THEN** the loader returns the factory without error; no
  reachability analysis is performed at load, and the first dispatch
  of `apply` fails at run time per the `graph-runner` capability's
  resume-resolution rules

#### Scenario: `resume:` survives an `extends:` node override

- **WHEN** the loader reads a derived factory whose `nodes` map
  redeclares `apply` in full, including `resume: plan`, over a base
  that declares `apply` without `resume:`
- **THEN** the resolved factory's `apply` node carries
  `resume: "plan"` (replace-at-node-level semantics apply unchanged);
  validation of the reference runs against the resolved factory

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

The `outputs:` field is independent of executor vs. step choice:
nodes that declare `uses:` MAY also declare `outputs:`, and the
loader SHALL preserve `outputs:` through step inlining unchanged
(the step body has no opinion on what a node declares as its
outputs). The `output_nudge_budget` and `resume` fields SHALL be
preserved through step inlining on the same independence basis.

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

### Requirement: Node `uses:` field as an alternative to inline executor

A factory node MAY declare a `uses:` field whose value SHALL be a non-empty string conforming to the `step-schema` capability's reference syntax (one of `minifac:<name>`, `<scope>/<name>[@<version>]`, or bare `<name>[@<version>]`). When a node declares `uses:`, it SHALL NOT also declare `executor:` or `with:` — the two patterns are mutually exclusive on a single node, and the loader SHALL reject a node that declares both.

A node with `uses:` MAY declare an `inputs:` field whose value SHALL be a flat object mapping input names (strings) to input values. The input values supply concrete values for the step's declared inputs; they are validated against the step's input schema at load time (see "Step input validation against the step's declared schema" requirement).

Node-level fields not specific to executor selection — `terminal`, `max_iterations`, `cwd`, `outputs`, `output_nudge_budget`, `resume`, and any future per-position fields — SHALL remain on the node regardless of whether the node uses inline `executor:` + `with:` or `uses:` + `inputs:`. These fields describe the node's position in the graph, not the step's behavior.

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

#### Scenario: Node with both `uses:` and `with:` is rejected

- **WHEN** the loader reads a node that declares both `uses: minifac:foo` and `with: { permission_mode: "bypass_permissions" }`
- **THEN** validation fails with an error naming the node id and explaining the mutual-exclusion rule

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
