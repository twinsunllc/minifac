## MODIFIED Requirements

### Requirement: Edge definition

Each edge SHALL declare `from` (node id) and `to` (node id), both of which
MUST reference declared nodes. An edge MAY declare `max_traversals`
(positive integer) and `when`, one of the literals `"on_success"`,
`"on_failure"` and `"on_error"`, defaulting to `"on_success"`. What each
value matches is defined by the graph-runner's "Edge traversal honors
`when` condition" requirement (ADR 0052).

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

## ADDED Requirements

### Requirement: Cycles closed by `on_error` edges need a budget

"Cycle budgets are mandatory" SHALL apply to `on_error` edges exactly as
to any other edge: a cycle is a cycle whatever the `when` of the edges
that close it, and an `on_error` edge's `max_traversals` covers the
cycles it lies on.

#### Scenario: An unbudgeted `on_error` cycle is rejected

- **WHEN** the loader reads A → B (`on_success`) and B → A (`on_error`)
  with no `max_traversals` on either edge and no `max_iterations` on
  either node
- **THEN** validation fails with the uncovered-cycle error naming A and B

#### Scenario: A budgeted `on_error` cycle is accepted

- **WHEN** the same graph declares `max_traversals: 2` on B → A
- **THEN** validation succeeds
