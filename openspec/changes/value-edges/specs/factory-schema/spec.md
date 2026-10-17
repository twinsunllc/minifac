## MODIFIED Requirements

### Requirement: Edge definition

Each edge SHALL declare `from` (node id) and `to` (node id), both of which
MUST reference declared nodes. An edge MAY declare `max_traversals`
(positive integer) and `when`, defaulting to `"on_success"`. `when` SHALL
be one of:

- the literals `"on_success"`, `"on_failure"` and `"on_error"`; or
- a value condition (ADR 0055): a mapping with `output` and exactly one of
  `equals` or `in`, and no other key. `output` is an output key matching
  `[a-zA-Z_][a-zA-Z0-9_]*` followed by zero or more `.<name>` property
  segments matching `[a-zA-Z0-9_-]+`. `equals` is a JSON scalar (string,
  number, boolean or `null`); `in` is a non-empty list of JSON scalars.

What each form matches is defined by the graph-runner's "Edge traversal
honors `when` condition" requirement (ADR 0052, ADR 0055).

#### Scenario: Edge to undeclared node fails validation

- **WHEN** an edge references a `to` id that is not in the `nodes` map
- **THEN** validation fails with an error naming the missing id and the
  edge's source location

#### Scenario: Unknown `when` value is rejected

- **WHEN** an edge declares `when: "on_weekend"`
- **THEN** validation fails with an error listing the supported values
  `on_success`, `on_failure` and `on_error`

#### Scenario: `on_error` is accepted

- **WHEN** an edge declares `when: "on_error"`
- **THEN** the factory loads and the edge's `when` is `"on_error"`

#### Scenario: A value condition is accepted

- **WHEN** an edge declares `when: { output: result.decision, equals: revise }`
  or `when: { output: result.decision, in: [revise, rework] }`
- **THEN** the schema accepts the edge and its `when` is that mapping

#### Scenario: A malformed value condition is rejected

- **WHEN** a value condition declares both `equals` and `in`, or neither, or
  a non-scalar `equals`, or an empty `in`, or an `output` that does not
  match the path grammar (e.g. `result..decision`)
- **THEN** validation fails with an error naming the problem

## ADDED Requirements

### Requirement: Value edge load-time validation

After step inlining, the loader SHALL check every edge whose `when` is a
value condition and SHALL refuse the factory with a `FactoryLoadError`
naming the edge (its `from`, `to` and condition) when:

1. the condition's output key is not a declared `type: value` output of the
   `from` node (step-declared outputs count, ADR 0054);
2. that output declares `schema:` and the path cannot exist under it: a
   segment meets a `false` schema, a schema whose `type` excludes `object`,
   or a schema with `additionalProperties: false` that has no `properties`
   entry and no matching `patternProperties` pattern for the segment; or
   the path ends at a `false` schema;
3. the path ends at a schema declaring `const` or `enum`, and an `equals`
   or `in` value is not allowed by it;
4. two value edges from the same node test the same `output` path and have
   a value in common. The error SHALL name both edges.

A path that only `$ref`, `allOf`, `anyOf`, `oneOf` or other keywords could
rule out SHALL be accepted. The loader SHALL NOT require the tested
property to be listed in the schema's `required`.

Value edges SHALL count as edges for start-node inference and for the
"Cycle budgets are mandatory" requirement and ADR 0053's per-cycle
warnings. A warning naming a value edge SHALL carry the edge's key form
(`output:<path>=<JSON>` or `output:<path> in <JSON array>`) as its
`edge.when`.

#### Scenario: Undeclared output key is refused

- **WHEN** an edge from `evaluate` declares `when: { output: verdict.decision, equals: x }`
  and `evaluate` declares no `verdict` output
- **THEN** loading fails naming the edge and the missing output

#### Scenario: A path the schema rules out is refused

- **WHEN** `evaluate`'s `result` schema sets `additionalProperties: false`
  with properties `decision` and `notes`, and an edge tests `result.verdict`
- **THEN** loading fails naming the edge, the path and the reason

#### Scenario: A value outside the enum is refused

- **WHEN** `result.decision` has `enum: [approve, revise, escalate]` and an
  edge tests `equals: aprove`
- **THEN** loading fails naming the value

#### Scenario: An undecidable path loads

- **WHEN** the schema reaches the property only through `$ref` or `anyOf`
- **THEN** the factory loads

#### Scenario: Overlapping value edges are refused

- **WHEN** one node declares edges on `result.decision` with `equals: revise`
  and `in: [revise, escalate]`
- **THEN** loading fails with an error naming both edges and `"revise"`

#### Scenario: A cycle closed by a value edge needs a budget

- **WHEN** `evaluate → implement` is a value edge closing the cycle
  `implement → evaluate → implement` and no edge or node in it carries a
  budget
- **THEN** loading fails as for any uncovered cycle
