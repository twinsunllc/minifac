## ADDED Requirements

### Requirement: `output_nudge_budget` per-node field

The factory loader SHALL accept an optional `output_nudge_budget` field on each node whose value MUST be a non-negative integer; when omitted, the field SHALL default to `1` on the resolved node so downstream consumers always see a populated integer.

`output_nudge_budget` declares how many in-turn nudge retries
the runner MAY use to recover a missing-required-output
protocol failure before recording the node as `failed` with
reason `missing_required_output`. Setting the field to `0`
opts the node out of the nudge loop entirely — the runner
SHALL fall through to the existing override-to-failed path on
the first detection of missing outputs.

The field SHALL be accepted on every node regardless of whether
the node declares an `outputs:` block. Nodes without an
`outputs:` block do not enter the post-execution validation
pass, and so the populated `output_nudge_budget` value has no
runtime effect; the schema accepts the field uniformly so
factory authors do not need to remember which nodes "should"
carry it.

The field SHALL be accepted on nodes that declare `uses:` +
`inputs:` (step-style nodes) in addition to inline `executor:` +
`with:` nodes, with the same default and semantics. Step
inlining SHALL preserve `output_nudge_budget` verbatim through
the inlined node (the step body has no opinion on nudge budgets,
mirroring the same independence already established for
`outputs:`).

A negative integer (e.g. `-1`), a non-integer (e.g. `1.5`), a
string (e.g. `"1"`), or any non-numeric value SHALL be rejected
with an error naming the node id and the offending value.

#### Scenario: Node without `output_nudge_budget` gets default of 1

- **WHEN** the loader reads a factory whose node declares
  `outputs: { findings: { type: "value", required: true } }`
  but omits `output_nudge_budget`
- **THEN** validation succeeds; the resolved node carries
  `output_nudge_budget: 1`

#### Scenario: Node with explicit `output_nudge_budget: 0` opts out

- **WHEN** the loader reads a node declaring
  `output_nudge_budget: 0` alongside an `outputs:` block
- **THEN** validation succeeds; the resolved node carries
  `output_nudge_budget: 0` (the runner SHALL skip the nudge
  loop for this node, per the graph-runner capability's
  "Post-execution nudge loop" requirement)

#### Scenario: Node with explicit `output_nudge_budget: 3` carries the override

- **WHEN** the loader reads a node declaring
  `output_nudge_budget: 3`
- **THEN** validation succeeds; the resolved node carries
  `output_nudge_budget: 3`

#### Scenario: Negative `output_nudge_budget` is rejected

- **WHEN** the loader reads a node declaring
  `output_nudge_budget: -1`
- **THEN** validation fails with an error naming the node id
  and the offending value

#### Scenario: Non-integer `output_nudge_budget` is rejected

- **WHEN** the loader reads a node declaring
  `output_nudge_budget: 1.5`
- **THEN** validation fails with an error naming the node id
  and the offending value

#### Scenario: String-typed `output_nudge_budget` is rejected

- **WHEN** the loader reads a node declaring
  `output_nudge_budget: "1"`
- **THEN** validation fails with an error naming the node id
  and the offending value

#### Scenario: Node without `outputs:` block accepts `output_nudge_budget`

- **WHEN** the loader reads a node declaring
  `output_nudge_budget: 1` but no `outputs:` block
- **THEN** validation succeeds; the resolved node carries
  `output_nudge_budget: 1` (the field has no runtime effect
  for nodes without declared outputs, but the schema accepts
  it uniformly)

#### Scenario: Step-style node carries `output_nudge_budget` through inlining

- **WHEN** the loader reads a node declaring
  `uses: minifac:openspec-propose`, `inputs: { change: "foo" }`,
  `outputs: { plan: { type: "file", filename: "plan.md" } }`,
  and `output_nudge_budget: 2`
- **THEN** validation succeeds; after step inlining the
  resolved node carries `output_nudge_budget: 2` alongside the
  inlined `executor`, `with`, and `outputs`

#### Scenario: `extends:` preserves `output_nudge_budget` at node level

- **WHEN** a base factory declares
  `nodes.security-review: { ..., output_nudge_budget: 2 }`
  and an extending factory declares
  `nodes.security-review: { ..., output_nudge_budget: 0 }`
- **THEN** per the existing replace-at-node-level merge
  semantics, the extending factory's node fully replaces the
  base's node; the resolved
  `output_nudge_budget` SHALL be `0` (the extending value)

## MODIFIED Requirements

### Requirement: Node definition

Each node SHALL declare an `executor` (string identifying a registered
runner, e.g. `claude`). It MAY declare `terminal` (boolean, default
`false`), `max_iterations` (positive integer), `cwd` (string),
`with` (free-form object passed verbatim to the executor),
`outputs` (see the "Node `outputs:` block" requirement), and
`output_nudge_budget` (see the "`output_nudge_budget` per-node
field" requirement).

A node MAY alternatively declare `uses:` + `inputs:` instead of
inline `executor:` + `with:` (see the "Node `uses:` field as an
alternative to inline executor" requirement). The accepted
node-level key set is: `executor`, `with`, `uses`, `inputs`,
`terminal`, `max_iterations`, `cwd`, `outputs`,
`output_nudge_budget`. Any other key SHALL be rejected with an
error naming the offending key and the node id.

The `outputs:` field is independent of executor vs. step choice:
nodes that declare `uses:` MAY also declare `outputs:`, and the
loader SHALL preserve `outputs:` through step inlining unchanged
(the step body has no opinion on what a node declares as its
outputs). The `output_nudge_budget` field SHALL be preserved
through step inlining on the same independence basis.

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
