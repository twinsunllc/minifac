## MODIFIED Requirements

### Requirement: Start nodes

The runner SHALL begin execution at every "start node". A node is a
start node when it has **no inbound edge from another node, of any
kind** (`on_success`, `on_failure`, or any edge kind added later), or
when it declares `start: true` (per the `factory-schema` capability's
"Node `start:` field" requirement). A self-loop (an edge whose `from`
and `to` are the same node) SHALL NOT count as an inbound edge for
this purpose, because it cannot make the node reachable from any other
node.

A node whose only inbound edges are `on_failure` is therefore NOT a
start node: it is an escalation, wait, or re-poll target and SHALL be
dispatched only when one of those edges is traversed. A node that is
the entry of a cycle — one with a back-edge into it — SHALL declare
`start: true` to start.

A factory MUST contain at least one start node. The loader SHALL
reject a factory with zero start nodes with an error that names the
nodes of the cycle(s) the graph can only be entered through (the
cyclic components no edge enters from outside) and states both fixes:
mark the entry node with `start: true`, or remove the edge into it.

The loader's validation and the runner's initial queue SHALL use the
same computation; start nodes SHALL be queued in the factory's node
declaration order.

#### Scenario: Single start node executes first

- **WHEN** a factory has nodes A, B with edge A → B (`on_success`) and
  the runner begins
- **THEN** node A is scheduled and runs before B

#### Scenario: Multiple start nodes are scheduled together

- **WHEN** a factory has nodes A, B, C with edges A → C and B → C (both
  `on_success`) and the runner begins
- **THEN** A and B are both eligible to run before C

#### Scenario: A node reachable only by an on_failure edge does not start

- **WHEN** a factory has nodes A, B, ASK, Z with edges A → B
  (`on_success`), B → ASK (`on_failure`), B → Z (`on_success`), and
  every node succeeds
- **THEN** the only start node is A; the run order is A, B, Z and ASK
  is never dispatched

#### Scenario: The on_failure-only node runs exactly when its source fails

- **WHEN** the same factory runs and B fails
- **THEN** the run order is A, B, ASK

#### Scenario: Cycle entry via on_failure edge is a start node

- **WHEN** a factory has nodes P, V with edges P → V (`on_success`) and
  V → P (`on_failure`), and P declares `start: true`
- **THEN** P is the sole start node and the run begins at P (V's edge
  back into P is an inbound edge, so P must declare itself; the old
  rule inferred this from the edge being `on_failure`, which is what
  let on_failure-only escalation nodes start too)

#### Scenario: A cycle's entry without `start: true` fails at load time

- **WHEN** a factory has nodes P, V with edges P → V (`on_success`) and
  V → P (`on_failure`), and neither declares `start: true`
- **THEN** the loader rejects the factory; the error says the factory
  has no start node, names the cycle `p → v`, and names `start: true`
  as the fix

#### Scenario: `start: true` dispatches a node with a forward inbound edge at begin

- **WHEN** a factory has nodes S, A, T (declared in that order) with
  edges A → S and S → T (both `on_success`), and S declares
  `start: true`
- **THEN** S is dispatched at run begin, before A has run

#### Scenario: Self-loop on failure does not disqualify a start node

- **WHEN** a factory has node A with edges A → A (`on_failure`) and
  A → T (`on_success`), and T is the only other node
- **THEN** A is a start node without declaring `start: true`

#### Scenario: No start nodes fails at load time

- **WHEN** a factory is constructed such that every node has at least
  one inbound edge from another node and none declares `start: true`
  (e.g. a closed loop with no entry)
- **THEN** the loader rejects the factory before the runner is
  invoked, naming the loop's nodes
