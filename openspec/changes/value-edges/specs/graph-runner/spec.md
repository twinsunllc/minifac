## MODIFIED Requirements

### Requirement: Edge traversal honors `when` condition

When a node completes, the runner SHALL classify the dispatch's outcome
as `success`, `failure` or `error` (see "Node outcome classification
and records") and select the outbound edges that outcome selects:

- `success` selects `when: "on_success"` (the default).
- `failure`, a judged failure, selects `when: "on_failure"`. It SHALL
  NOT select `on_error` edges.
- `error` selects `when: "on_error"` when the node DECLARES at least one
  `on_error` edge, and `when: "on_failure"` otherwise. Whether one is
  declared decides, not whether one is traversable: when every declared
  `on_error` edge is budget-exhausted, the runner SHALL NOT fall back to
  `on_failure` edges, and the run ends `budget_exhausted`.

Value edges (ADR 0055): on a `success` or a `failure`, when the node
declares edges whose `when` is a value condition, the runner SHALL read
each tested output from the node's indexed outputs, walk the path through
plain objects, and compare by strict equality. When one or more value
edges match, the runner SHALL select every matching value edge and none of
the outcome's literal edges. When none matches, including when the output
is absent, unindexed (it mismatched its schema) or does not parse, the
runner SHALL select the outcome's literal edges as above and SHALL emit
and persist a stderr line `value_edges: node "<id>" matched no value
edge; following <when> edges`. On an `error`, the runner SHALL NOT select
value edges.

Selection SHALL happen before budgets are read: a selected edge that is
budget-exhausted is skipped, and the runner SHALL NOT fall back to other
edges because of it.

Traversal counts SHALL be keyed `<from>-><to>:<when>`, where a value
edge's `<when>` is `output:<path>=<JSON>` for `equals` and
`output:<path> in <JSON array>` for `in`. The same key SHALL be used for
`max_traversals`, for `ParkedRun.edgeTraversals` and
`ResumeState.edgeTraversals`, and for the dispatch's entering edge
(`via`).

A node that failed or errored and traversed no edge ends the run as
"Run termination" describes (`node_failed`, or `budget_exhausted` when
a selected edge was skipped on a budget).

#### Scenario: Failed node does not traverse default edges

- **WHEN** node A fails and has a single outbound edge A → B with no
  explicit `when`
- **THEN** B is not scheduled

#### Scenario: Failed node traverses an on_failure edge

- **WHEN** node A fails and has an outbound edge A → R with
  `when: "on_failure"`
- **THEN** R is scheduled

#### Scenario: An errored node takes its on_error edge

- **WHEN** node A errors and has outbound edges A → E (`on_error`) and
  A → R (`on_failure`)
- **THEN** E is scheduled and R is not

#### Scenario: An errored node with no on_error edge falls back

- **WHEN** node A errors and has only A → R (`on_failure`)
- **THEN** R is scheduled, as before `on_error` existed

#### Scenario: A judged failure never takes on_error

- **WHEN** node A fails with a judgment (e.g. `MINIFAC_STATUS: failed`)
  and has outbound edges A → E (`on_error`) and A → R (`on_failure`)
- **THEN** R is scheduled and E is not

#### Scenario: An exhausted on_error edge does not fall back

- **WHEN** node A errors, its only `on_error` edge has spent its
  `max_traversals`, and it also declares A → R (`on_failure`)
- **THEN** R is not scheduled and the run ends `budget_exhausted`

#### Scenario: on_error edges count against max_traversals

- **WHEN** node A always errors and declares A → A (`on_error`,
  `max_traversals: 2`)
- **THEN** A is dispatched three times, the traversal count under key
  `A->A:on_error` reaches 2, and the run ends `budget_exhausted`

#### Scenario: A three-way value route

- **WHEN** `evaluate` declares value edges on `result.decision` to
  `verify` (`approve`), `implement` (`revise`) and `escalate`
  (`escalate`), and succeeds with each decision in turn
- **THEN** exactly the matching successor is scheduled each time

#### Scenario: No value edge matches

- **WHEN** `evaluate` succeeds with `decision: other` and also declares
  `evaluate → fallback` (`on_success`)
- **THEN** `fallback` is scheduled and a stderr line beginning
  `value_edges:` is emitted and persisted; on a judged failure the
  `on_failure` edge is taken instead

#### Scenario: A schema-mismatched value matches nothing

- **WHEN** `evaluate`'s value would match a value edge but violates its
  schema
- **THEN** the node fails with outcome `failure` (ADR 0054) and routes
  `on_failure`

#### Scenario: An error ignores value edges

- **WHEN** `evaluate` errors having written a value that matches a value
  edge, and declares an `on_error` edge
- **THEN** only the `on_error` edge is taken

#### Scenario: A value-edge loop is bounded and does not fall back

- **WHEN** `evaluate` always returns `revise` and `evaluate → implement`
  (value edge, `max_traversals: 2`) closes the loop, and `evaluate` also
  declares an `on_success` edge
- **THEN** `implement` is dispatched three times, the count under
  `evaluate->implement:output:result.decision="revise"` reaches 2, the
  `on_success` edge is never taken, and the run ends `budget_exhausted`

#### Scenario: Park and resume carry a value edge's count

- **WHEN** the same run parks before the third `implement` and is resumed
  with the parked `edgeTraversals` and `via`
- **THEN** the resumed `implement` renders `{{ edge.traversals }}` as `2`
  and the run ends `budget_exhausted` after one more `evaluate`
