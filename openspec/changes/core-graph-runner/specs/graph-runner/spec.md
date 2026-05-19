## ADDED Requirements

### Requirement: Start nodes

The runner SHALL begin execution at every "start node" — defined as a
node with no `on_success` inbound edges. A factory MUST contain at least
one start node; the loader SHALL reject factories with zero. `on_success`
edges represent forward flow; `on_failure` edges represent recovery loops
back into nodes that may have been traversed previously, so a node whose
only inbound edges are `on_failure` is still an entry point for the
forward flow.

#### Scenario: Single start node executes first

- **WHEN** a factory has nodes A, B with edge A → B (`on_success`) and
  the runner begins
- **THEN** node A is scheduled and runs before B

#### Scenario: Multiple start nodes are scheduled together

- **WHEN** a factory has nodes A, B, C with edges A → C and B → C (both
  `on_success`) and the runner begins
- **THEN** A and B are both eligible to run before C

#### Scenario: Cycle entry via on_failure edge is a start node

- **WHEN** a factory has nodes P, V with edges P → V (`on_success`) and
  V → P (`on_failure`)
- **THEN** P is a start node (V's edge back to P is `on_failure`,
  recovery flow, so P has no `on_success` inbound)

#### Scenario: Self-loop on failure does not disqualify a start node

- **WHEN** a factory has node A with edges A → A (`on_failure`) and
  A → T (`on_success`), and T is the only other node
- **THEN** A is a start node

#### Scenario: No start nodes fails at load time

- **WHEN** a factory is constructed such that every node has at least one
  `on_success` inbound edge (e.g. a closed `on_success` loop with no
  entry)
- **THEN** the loader rejects the factory before the runner is invoked

### Requirement: Edge traversal honors `when` condition

When a node completes, the runner SHALL evaluate each outbound edge's
`when` condition against the node's outcome and traverse only matching
edges. An edge with `when: "on_success"` (default) traverses only when
the source node reports a `succeeded` status; `when: "on_failure"`
traverses only on `failed`.

#### Scenario: Failed node does not traverse default edges

- **WHEN** node A fails and has a single outbound edge A → B with no
  explicit `when`
- **THEN** B is not scheduled

#### Scenario: Failed node traverses an on_failure edge

- **WHEN** node A fails and has an outbound edge A → R with
  `when: "on_failure"`
- **THEN** R is scheduled

### Requirement: Cycle budgets are enforced at runtime

The runner SHALL track edge traversal counts and node execution counts.
When traversing an edge would exceed its `max_traversals`, the edge is
skipped. When scheduling a node would exceed its `max_iterations`, the
node is not scheduled.

#### Scenario: Edge budget halts a retry loop

- **WHEN** edge V → P has `max_traversals: 2` and V → P has already been
  traversed twice
- **THEN** a third attempt to traverse V → P does not schedule P

#### Scenario: Node budget halts repeated execution

- **WHEN** node P has `max_iterations: 3` and has already executed three
  times
- **THEN** subsequent attempts to schedule P are skipped

### Requirement: Run termination

A run SHALL end with status `succeeded` when a terminal node completes
with status `succeeded`. A run SHALL end with status `failed` when:
(a) a node fails and no outbound `on_failure` edges remain traversable,
(b) all relevant cycle budgets are exhausted before any terminal node
succeeds, or (c) the graph drains (no node is eligible to run) without a
successful terminal node.

#### Scenario: Terminal node completion ends the run

- **WHEN** a node with `terminal: true` completes with `succeeded`
- **THEN** the runner stops scheduling new nodes and returns a
  `succeeded` run result, even if other nodes were still eligible

#### Scenario: Budget exhaustion ends the run as failed

- **WHEN** the only path to a terminal node passes through an edge whose
  `max_traversals` budget has been exhausted
- **THEN** the runner returns a `failed` run result with a reason that
  identifies budget exhaustion

#### Scenario: Terminal node may participate in a cycle

- **WHEN** a terminal node V is reached via a cycle (e.g. V loops back
  to P on failure, terminates on success) and V succeeds on the second
  iteration
- **THEN** the runner ends with `succeeded`, having traversed the cycle
  once

### Requirement: Run-wide history is accumulated and passed to each node

The runner SHALL maintain an ordered, run-wide history of every event
emitted by every node in the run, tagged with the emitting node id and
the iteration count of that node at the time of emission. When a node is
scheduled, the runner SHALL pass a read-only snapshot of the history
through the executor's run context. Subsequent iterations of the same
node in a cycle SHALL therefore receive their own prior outputs (and the
outputs of every other node that ran in between).

#### Scenario: History accumulates across nodes

- **WHEN** node A runs and emits two stdout events, then node B runs
- **THEN** the run context passed to B contains both of A's events, in
  emission order, each tagged with `nodeId: "A"` and `iteration: 1`

#### Scenario: A node's second iteration sees its first iteration

- **WHEN** node P runs (iteration 1), then node V runs and fails, then
  the runner cycles back to P for iteration 2
- **THEN** the run context passed to P on iteration 2 contains P's
  iteration-1 events and V's iteration-1 events, in order

#### Scenario: History snapshot is stable for the duration of a node run

- **WHEN** node A is running and node B (running concurrently in a future
  fan-out) emits events
- **THEN** A's history snapshot does not change mid-run; A sees only the
  history that existed when it was scheduled. (v0 is single-flight, so
  this is trivially true; the rule is documented to bind future fan-out.)

### Requirement: Streaming node events

While a node is executing, the runner SHALL forward every event yielded
by that node's executor (`stdout`, `stderr`, `status`) to a consumer
provided at run invocation, in order, without buffering beyond what is
necessary to deliver one event at a time.

#### Scenario: Consumer sees events as they arrive

- **WHEN** an executor yields three `stdout` events spaced 100ms apart
- **THEN** the consumer receives them in order, each within a small
  constant of the time the executor yielded it (no batching at end of run)

### Requirement: Run result is structured

When a run ends, the runner SHALL return a structured result containing:
overall status (`succeeded` | `failed`), the reason for termination, the
sequence of nodes that executed (with per-node status and counts), and
the total run duration.

#### Scenario: Failed run result names the failed node

- **WHEN** node P fails and no recovery edge is available
- **THEN** the run result has `status: "failed"` and a reason that
  identifies P as the failing node
