## ADDED Requirements

### Requirement: Node `start:` field

A factory node MAY declare an optional `start:` field whose value
SHALL be a boolean. `start: true` declares the node a start node — one
the runner dispatches when the run begins — regardless of its inbound
edges (the `graph-runner` capability's "Start nodes" requirement
defines the inferred rule this overrides). `start: false` SHALL have
the same meaning as omitting the field. The schema SHALL NOT supply a
default; a node that omits `start:` SHALL carry no `start` property
after parsing.

The field is a node-level (topology) concern, not an executor payload.
It SHALL be accepted alongside inline `executor:` + `with:` AND
alongside `uses:` + `inputs:`, and the loader SHALL preserve it
through step inlining unchanged — on the same independence basis as
`terminal`, `max_iterations` and `resume`. Under `extends:` it follows
replace-at-node-level semantics with the rest of the node.

Declaring `start: true` on a node that has no inbound edge from
another node is redundant and SHALL be accepted. A non-boolean value
SHALL be rejected at load time with an error naming the field.

#### Scenario: `start: true` on a cycle's entry node is accepted and honored

- **WHEN** the loader reads a factory whose `p` node declares
  `start: true` and whose edges are `p → v` and `v → p` (`on_failure`,
  `max_traversals: 2`)
- **THEN** validation succeeds; the resolved `p` node carries
  `start: true`; the start-node computation yields exactly `p`

#### Scenario: `start:` is preserved through step inlining

- **WHEN** the loader reads a node declaring `uses:` + `inputs:` and
  `start: true`
- **THEN** the resolved node carries `start: true` and the step body
  is inlined exactly as it would be for a node without `start:`

#### Scenario: Omitted `start:` has no default

- **WHEN** the loader reads a node that does not declare `start:`
- **THEN** the resolved node has no `start` property

#### Scenario: Non-boolean `start:` is rejected

- **WHEN** the loader reads a node whose `start:` is the string
  `"yes please"`
- **THEN** validation fails with an error naming `start`
