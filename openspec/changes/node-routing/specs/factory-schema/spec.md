## ADDED Requirements

### Requirement: Node routes

A node MAY declare `routes:`, a non-empty list of the nodes its result may
name as the next to run (ADR 0055). Each entry SHALL be a node id or a
mapping `{ to: <id>, max_traversals: <positive integer> }`; `{ to: <id> }`
without a budget means the same as the bare id. The loader SHALL refuse an
empty list, an entry naming the same node as an earlier entry, a mapping
with any other key, and a non-positive or non-integer `max_traversals`.
`routes:` is a workflow field: a step file declaring it SHALL be refused.
`routes:` survives step inlining on a `uses:` node.

After step inlining, the loader SHALL give every routing node a
synthesized output `next` of `type: value`, `required: false`, whose
`schema` is `{ enum: [<route ids in declaration order>..., null] }`. A
routing node that already has an output named `next`, declared on the node
or inherited from its step, SHALL be a load error. A node without `routes:`
MAY declare an output named `next`, and gets nothing synthesized.

Each entry SHALL be treated as an edge `<node> → <to>` for every static
rule:

- an entry naming an undeclared node SHALL be a load error naming the node
  and the entry;
- an entry whose target has no path, along declared edges of any `when`
  and routes, to a `terminal: true` node SHALL be a load error naming the
  node and the entry (a terminal target passes);
- a route target is not a start node by virtue of the route alone;
- cycle budgets (ADR 0053): a cycle closed by a route needs a budget, which
  a route entry's `max_traversals` or a node's `max_iterations` supplies;
  an uncovered cycle in a budgeted component is an `uncovered_cycle`
  warning whose `edge.when` is `route`.

Routes are not added to the resolved factory's `edges`. An `extends:`
layer that redeclares a routing node replaces it whole, so a layer that
omits `routes:` drops them and the synthesized output with them.

#### Scenario: Both entry forms are accepted

- **WHEN** a node declares `routes: [implement, { to: checks_gate,
  max_traversals: 2 }]`
- **THEN** the factory loads and the node's `next` output has schema
  `{ enum: [implement, checks_gate, null] }` and is not required

#### Scenario: A duplicate route is refused

- **WHEN** a node declares `routes: [a, { to: a, max_traversals: 1 }]`
- **THEN** loading fails naming the duplicate `a`

#### Scenario: A step may not declare routes

- **WHEN** a step file declares `routes:`
- **THEN** loading a factory that uses it fails on the unrecognized key

#### Scenario: A routing node may not declare next

- **WHEN** a routing node declares an output `next`, or uses a step that
  declares one
- **THEN** loading fails naming the node

#### Scenario: A route to an undeclared node is refused

- **WHEN** `evaluate` declares `routes: [implement, nowhere]` and no node
  `nowhere` exists
- **THEN** loading fails with `Node "evaluate" routes entry "nowhere"
  (routes[1]) names no declared node`

#### Scenario: A route that cannot reach a terminal node is refused

- **WHEN** `evaluate` routes to `dead_end`, which has no outbound edge or
  route and is not terminal
- **THEN** loading fails naming `evaluate`, `dead_end` and that it cannot
  reach a terminal node

#### Scenario: An unbudgeted route cycle is refused

- **WHEN** `implement → checks_gate → review → evaluate` and `evaluate`
  declares `routes: [implement]`, with no budget in the cycle
- **THEN** loading fails with "Cycle is not covered by any budget"

#### Scenario: A route budget covers its cycle

- **WHEN** the same `evaluate` declares `routes: [{ to: implement,
  max_traversals: 2 }]`
- **THEN** the factory loads with no warning

#### Scenario: A graph without routes is unchanged

- **WHEN** no node declares `routes:`
- **THEN** no output is synthesized and start nodes, cycle results and
  edge keys are what they were before routes existed
