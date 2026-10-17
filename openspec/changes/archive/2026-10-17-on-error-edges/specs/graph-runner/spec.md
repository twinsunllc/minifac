## MODIFIED Requirements

### Requirement: Edge traversal honors `when` condition

When a node completes, the runner SHALL classify the dispatch's outcome
as `success`, `failure` or `error` (see "Node outcome classification
and records") and traverse only the outbound edges that outcome
selects:

- `success` selects `when: "on_success"` (the default).
- `failure`, a judged failure, selects `when: "on_failure"`. It SHALL
  NOT select `on_error` edges.
- `error` selects `when: "on_error"` when the node DECLARES at least one
  `on_error` edge, and `when: "on_failure"` otherwise. Whether one is
  declared decides, not whether one is traversable: when every declared
  `on_error` edge is budget-exhausted, the runner SHALL NOT fall back to
  `on_failure` edges, and the run ends `budget_exhausted`.

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

### Requirement: Run termination

A run SHALL end with status `succeeded` when a terminal node completes
with status `succeeded`. A run SHALL end with status `failed` when:
(a) a node fails or errors and no outbound edge its outcome selects
(see "Edge traversal honors `when` condition") remains traversable,
(b) all relevant cycle budgets are exhausted before any terminal node
succeeds, or (c) the graph drains (no node is eligible to run) without a
successful terminal node. A run SHALL end with status `parked` when the
caller's `onNodeBoundary` hook returns `"park"` for the next dispatch (see
the "Between-node boundary hook and park" requirement); a parked run is
neither succeeded nor failed.

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

#### Scenario: A park ends the run as parked

- **WHEN** the `onNodeBoundary` hook returns `"park"` before node B
- **THEN** B is not dispatched and the runner returns a `parked` run
  result with reason `parked`

### Requirement: Cross-node session resume resolution

When a resolved node declares `resume: <node-id>` (per the
`factory-schema` capability's "Node `resume:` field" requirement),
the runner SHALL resolve a session id for the dispatch BEFORE
invoking the executor, and SHALL thread the resolved value to the
executor through the run context as `ctx.resumeSessionId`.

Resolution SHALL be: the `session_id` captured for the **most recent
completed dispatch** of the named node in this run — the same
latest-entry-per-`nodeId` rule the runner already applies when
building the prior-results map. Resolution SHALL NOT cross run
boundaries: only dispatches within the current run are candidates.

The named node's terminal status SHALL NOT affect resolution. A
session captured for a dispatch that terminated `failed` is a valid
resume target, so that a recovery node reached by an `on_failure`
edge can continue the failed node's conversation.

The runner SHALL fail the dispatch **before spawning any child
process** in each of the following cases, yielding a terminal
`failed` status for the node iteration:

- **No prior dispatch.** The named node has no entry in this run's
  prior results. `meta.reason` SHALL be `resume_unavailable` and the
  metadata SHALL distinguish this case (e.g. detail
  `no_prior_dispatch`). The `NodeResult.reason` SHALL be
  `resume_unavailable`.
- **No session captured.** The named node was dispatched but its
  latest entry's `session_id` is `null`. `meta.reason` SHALL be
  `resume_unavailable` with a detail distinguishing it from the
  no-dispatch case (e.g. `no_session_captured`). The
  `NodeResult.reason` SHALL be `resume_unavailable`.
- **Executor cannot resume.** The executor resolved for the node
  exposes `supportsResume: false` (per the `node-executor`
  capability's "Executor `supportsResume` capability flag"
  requirement). `meta.reason` SHALL be `resume_unsupported` and the
  `NodeResult.reason` SHALL be `resume_unsupported`.

The runner SHALL NOT fall back to starting a fresh session when a
resume cannot be satisfied. A silent fallback would produce a
plausible-looking result from a node that was designed around
context it never received.

These are node errors (ADR 0052): the node's `on_error` edges SHALL
traverse when it declares any, and its `on_failure` edges otherwise;
the failed iteration SHALL be recorded in prior results
and (when a store is in scope) in `node_executions`, and the run's
terminal reason SHALL follow the existing "Run termination" rules.

The runner SHALL NOT inspect, locate, or validate the executor's
session storage. Whether the named session is still readable is
determined by the child process; a resolved-but-unusable session
SHALL surface through the executor's ordinary exit-code path.

Nodes that declare no `resume:` SHALL be dispatched with
`ctx.resumeSessionId` absent, and their behavior SHALL be unchanged.

#### Scenario: Resume resolves the target node's captured session

- **WHEN** node `plan` runs first and its dispatch captures
  `session_id: "abc-123"`, and node `apply` declares `resume: plan`
- **THEN** `apply` is dispatched with
  `ctx.resumeSessionId === "abc-123"`

#### Scenario: Later iteration resumes the target's newest session

- **WHEN** node `apply` declares `resume: plan` and
  `max_iterations: 2`; `plan` iteration 1 captures `"s1"`, `apply`
  iteration 1 runs, a cycle re-dispatches `plan` (iteration 2,
  capturing `"s2"`), then `apply` iteration 2 is dispatched
- **THEN** `apply` iteration 1 was dispatched with
  `ctx.resumeSessionId === "s1"` and `apply` iteration 2 is
  dispatched with `ctx.resumeSessionId === "s2"` — the latest
  dispatch of the named node wins on every iteration

#### Scenario: Repeated iteration without a target re-run reuses the same session

- **WHEN** node `apply` declares `resume: plan`, `plan` ran exactly
  once capturing `"s1"`, and a cycle re-dispatches only `apply`
- **THEN** `apply` iteration 2 is dispatched with
  `ctx.resumeSessionId === "s1"` — the same session it resumed on
  iteration 1, not the session `apply` itself announced

#### Scenario: Resume target that never ran fails before spawn

- **WHEN** node `apply` declares `resume: verify` and `verify` has
  not been dispatched in this run when `apply` is popped
- **THEN** the runner yields a terminal
  `{ status: "failed", meta: { reason: "resume_unavailable", ... } }`
  for `apply` without spawning a child process; the appended
  `NodeResult` carries `status: "failed"` and
  `reason: "resume_unavailable"`

#### Scenario: Resume target that captured no session fails before spawn

- **WHEN** node `plan` was dispatched but terminated before
  announcing a session (its `NodeResult.session_id` is `null`), and
  node `apply` declares `resume: plan`
- **THEN** the runner yields a terminal `failed` status for `apply`
  with `meta.reason === "resume_unavailable"` and metadata
  distinguishing the no-session case from the no-dispatch case; no
  child process is spawned

#### Scenario: Failed resume target with a session still resumes

- **WHEN** node `plan` terminates `failed` with a sentinel reason but
  its dispatch captured `session_id: "abc-123"`, and an `on_failure`
  edge reaches node `recover` which declares `resume: plan`
- **THEN** `recover` is dispatched with
  `ctx.resumeSessionId === "abc-123"`; the target's failed status
  does not block resolution

#### Scenario: Non-resume-capable executor fails before spawn

- **WHEN** node `apply` declares `resume: plan`, `plan` captured a
  session, and `apply`'s resolved executor exposes
  `supportsResume: false`
- **THEN** the runner yields a terminal `failed` status for `apply`
  with `meta.reason === "resume_unsupported"`; no child process is
  spawned and `ctx.resumeSessionId` is never threaded

#### Scenario: Unusable session surfaces through the exit code

- **WHEN** node `apply` resolves `ctx.resumeSessionId` successfully
  but the child process exits non-zero because the CLI cannot read
  that session
- **THEN** the runner records `apply` as `failed` through the
  ordinary exit-code path with `meta.exitCode` populated; the runner
  performs no pre-flight check of the session's on-disk state and
  emits no `resume_unavailable` reason

#### Scenario: Nodes without `resume:` are dispatched unchanged

- **WHEN** a factory declares no `resume:` on any node
- **THEN** every dispatch receives a run context with no
  `resumeSessionId`, and the run's behavior is identical to
  pre-change behavior

#### Scenario: Resume failure is a node error for edges

- **WHEN** node `apply` fails with `reason: "resume_unavailable"` and
  the factory declares an edge `apply → recover` with
  `when: "on_failure"` and no `on_error` edge from `apply`
- **THEN** the runner traverses the edge and schedules `recover`, and
  `recover`'s `priorResults` contains `apply`'s entry with
  `status: "failed"` and `reason: "resume_unavailable"`

## ADDED Requirements

### Requirement: Node outcome classification and records

The runner SHALL classify every dispatch it records into a
`NodeOutcome` (`"success" | "failure" | "error"`):

- From the executor's terminal `status` event: `succeeded` is
  `success`; `failed` is `error` when the event carries
  `outcome: "error"` and `failure` otherwise.
- `error` for the runner's own failure paths: a pre-spawn
  `resume_unavailable` or `resume_unsupported`; an event stream that
  ends with no terminal status; and the `missing_required_output`
  override of a claimed success. A template substitution error SHALL
  record `outcome: "error"` on the node's store row; the run still
  ends `node_failed` without routing.

The outcome SHALL be carried on:

- each `priorResults` entry (`NodeResult.outcome`);
- each `RunResult.log` entry (`ExecutionLogEntry.outcome`), which SHALL
  also reflect the `missing_required_output` override
  (`status: "failed"`, `outcome: "error"`);
- `recordNodeEnd` (`RecordNodeEndInput.outcome`) for every dispatch;
- every terminal `status` event the runner delivers to `onEvent` and
  persists, the runner setting `outcome` when the executor left it
  out.

`status`, `reason`, `meta` and `RunReason` SHALL keep their existing
values. `NodeResult.outcome` SHALL be optional in the type so callers
that build NodeResults themselves still type-check; the runner SHALL
always set it.

#### Scenario: A crash is recorded as an error everywhere

- **WHEN** node A's executor yields `{ status: "failed",
  outcome: "error" }` and A has an `on_error` edge to E
- **THEN** `log[A].outcome`, the `priorResults` entry E sees, the store
  row and the delivered status event all say `error`

#### Scenario: A claimed success without outputs is an error

- **WHEN** a node succeeds without a required declared output and every
  nudge is spent
- **THEN** its outcome is `error`, its log entry says `failed` / `error`,
  and it takes its `on_error` edge when it declares one

#### Scenario: A stream with no terminal status is an error

- **WHEN** an executor's event stream ends without a terminal status
- **THEN** the dispatch is `failed` with outcome `error`
