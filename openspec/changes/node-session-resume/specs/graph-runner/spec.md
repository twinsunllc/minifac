## ADDED Requirements

### Requirement: Per-dispatch session id capture

The runner SHALL capture the executor session identifier for every
node dispatch by inspecting the dispatch's `stdout` events. A line
that parses as JSON and carries `type: "system"`, `subtype: "init"`,
and a non-empty string `session_id` SHALL be treated as a session
announcement; the runner SHALL retain the value of the LAST such
line seen during the dispatch.

Parsing SHALL be non-fatal in every failure mode, matching the
runner's existing stdout inspection posture: a line that is not JSON,
that is JSON of another shape, or that carries a `session_id` of a
non-string type SHALL be ignored for session capture and SHALL still
be emitted as an ordinary `stdout` event. Capture SHALL NOT alter,
suppress, or reorder any event.

The captured value SHALL be recorded in two places:

- On the dispatch's `NodeResult` as `session_id` (per the modified
  "Prior-results accumulate across node executions" requirement).
  `null` when no session announcement was seen.
- Through `store.recordNodeEnd(...)` as the `sessionId` input (per
  the `run-storage` capability's "Schema v4 adds `session_id` to
  `node_executions`" requirement), when a `RunStore` is in scope.

A dispatch that resumes another node's session SHALL record the id
the resumed session announces, verbatim. The runner SHALL NOT
de-duplicate, rewrite, or synthesize session ids: two node
executions that share one conversation legitimately carry the same
`session_id`.

#### Scenario: Session id is captured from the init line

- **WHEN** a node dispatch's first stdout line is
  `{"type":"system","subtype":"init","session_id":"abc-123", ...}`
  and the node terminates `succeeded`
- **THEN** the `NodeResult` appended for that dispatch carries
  `session_id: "abc-123"`, and (when a store is in scope)
  `recordNodeEnd` is invoked with `sessionId: "abc-123"`

#### Scenario: Dispatch with no init line records a null session id

- **WHEN** a node dispatch emits stdout lines none of which is a
  `system` / `init` announcement (e.g. the CLI aborted before
  initializing)
- **THEN** the `NodeResult` appended for that dispatch carries
  `session_id: null`, and `recordNodeEnd` is invoked with
  `sessionId: null`

#### Scenario: Non-JSON and off-shape lines are ignored for capture

- **WHEN** a node dispatch emits a non-JSON stdout line, a JSON line
  of another `type`, and a `system` / `init` line whose `session_id`
  is a number
- **THEN** none of the three contributes a captured session id; each
  is still emitted as an ordinary `stdout` event in order, and the
  dispatch's `session_id` remains `null` unless a valid announcement
  arrives

#### Scenario: Last announcement in a dispatch wins

- **WHEN** a node dispatch emits two `system` / `init` lines carrying
  `session_id` values `"first"` then `"second"`
- **THEN** the dispatch's captured `session_id` is `"second"`

#### Scenario: Resumed dispatch records the resumed session's id

- **WHEN** node `apply` declares `resume: plan`, `plan`'s dispatch
  captured `session_id: "abc-123"`, and `apply`'s dispatch announces
  `session_id: "abc-123"` (the same conversation)
- **THEN** `apply`'s `NodeResult` carries `session_id: "abc-123"`;
  the runner records it verbatim and does not treat the collision as
  an error

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

These are ordinary node failures: `on_failure` edges SHALL traverse
normally, the failed iteration SHALL be recorded in prior results
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

#### Scenario: Resume failure is an ordinary node failure for edges

- **WHEN** node `apply` fails with `reason: "resume_unavailable"` and
  the factory declares an edge `apply → recover` with
  `when: "on_failure"`
- **THEN** the runner traverses the edge and schedules `recover`, and
  `recover`'s `priorResults` contains `apply`'s entry with
  `status: "failed"` and `reason: "resume_unavailable"`

## MODIFIED Requirements

### Requirement: Prior-results accumulate across node executions

The runner SHALL maintain an ordered, run-wide array of structured
`NodeResult` entries — one entry per completed node execution,
appended in completion order at the moment the executor's event
stream drains and the node's terminal status is resolved. Each
entry SHALL have exactly the following shape:

```ts
{
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  reason: string | null;   // sentinel REASON when failed; null otherwise
  startedAt: number;       // ms since run start
  endedAt: number;         // ms since run start
  outputs: NodeOutputIndex | null;  // per the "NodeResult.outputs" requirement
  session_id: string | null;        // per the "Per-dispatch session id capture" requirement
}
```

When a node is scheduled, the runner SHALL pass a read-only, frozen
snapshot of the `priorResults` array through the executor's run
context as `ctx.priorResults`. Subsequent iterations of the same node
in a cycle SHALL therefore receive their own prior result entries
(and the entries of every other node that ran in between).

The `reason` field SHALL be populated from the executor's terminal
`status` event `meta` payload: when `meta.reason === "sentinel_failed"`
and `meta.sentinel` is a string, `reason` SHALL be that string
(trimmed of trailing whitespace). When the runner overrides a
node's terminal status to `failed` due to missing required outputs
(per the "Post-execution outputs validation" requirement),
`reason` SHALL be the string `missing_required_output`. When the
runner fails a dispatch before spawn because a declared `resume:`
target could not be resolved or the executor cannot resume (per the
"Cross-node session resume resolution" requirement), `reason` SHALL
be `resume_unavailable` or `resume_unsupported` respectively. In all
other cases (successful executions, non-sentinel non-output
failures), `reason` SHALL be `null`.

The `outputs` field SHALL be populated per the
"`NodeResult.outputs` field on prior results" requirement: a
populated `NodeOutputIndex` for satisfied outputs on succeeded
nodes; `null` otherwise.

The `session_id` field SHALL be populated per the "Per-dispatch
session id capture" requirement: the id announced by the dispatch's
`system` / `init` line, or `null` when no announcement was seen —
including for dispatches the runner failed before spawn.

Skipped nodes (those that hit the `max_iterations` budget at pop
time and were not actually dispatched to an executor) SHALL NOT
contribute an entry to `priorResults`.

The runner SHALL NOT pass the raw per-event run history through
the run context. The `onEvent` streaming consumer SHALL continue
to receive every event in real time, unchanged.

#### Scenario: Prior-results accumulate across nodes

- **WHEN** node A runs and completes with `succeeded` after
  emitting two stdout events, then node B is scheduled
- **THEN** the run context passed to B contains `priorResults`
  with exactly one entry: `{ nodeId: "A", iteration: 1,
  status: "succeeded", reason: null, startedAt: <ms>,
  endedAt: <ms>, outputs: null, session_id: <captured-id-or-null> }`
  (the `outputs` field defaults to `null` when A declared no outputs)

#### Scenario: A node's second iteration sees its first iteration's result

- **WHEN** node P runs (iteration 1) and succeeds, then node V
  runs and fails with a sentinel REASON of `"verify hit error"`,
  then the runner cycles back to P for iteration 2
- **THEN** the run context passed to P on iteration 2 contains
  `priorResults` with two entries in order: P iter 1 (status
  `succeeded`, `reason: null`, `outputs: null`), then V iter 1
  (status `failed`, `reason: "verify hit error"`,
  `outputs: null`)

#### Scenario: Prior-results snapshot is stable for the duration of a node run

- **WHEN** node A is running and node B (running concurrently in
  a future fan-out) completes
- **THEN** A's `priorResults` snapshot does not change mid-run;
  A sees only the entries that existed when it was scheduled.
  (v0 is single-flight, so this is trivially true; the rule is
  documented to bind future fan-out.)

#### Scenario: Non-sentinel failure records null reason

- **WHEN** a node fails via non-zero exit code with no
  `MINIFAC_STATUS:` sentinel in the final result event
- **THEN** the entry appended to `priorResults` has `status:
  "failed"`, `reason: null`, and `outputs: null`

#### Scenario: Missing-required-output override records the named reason

- **WHEN** a node terminates `succeeded` at the executor layer
  but the outputs validator overrides it to `failed` because a
  required output is missing
- **THEN** the entry appended to `priorResults` has `status:
  "failed"`, `reason: "missing_required_output"`, and
  `outputs: null` (the partial index lives on the per-execution
  failure metadata, not on the prior-results snapshot)

#### Scenario: Successful execution with satisfied outputs records the index

- **WHEN** a node terminates `succeeded` with both required
  outputs satisfied
- **THEN** the entry appended to `priorResults` has `status:
  "succeeded"`, `reason: null`, and `outputs` populated with
  the `NodeOutputIndex` of present-and-satisfied keys

#### Scenario: Unresolvable resume records the named reason and a null session

- **WHEN** a node declaring `resume: plan` is failed before spawn
  because `plan` captured no session
- **THEN** the entry appended to `priorResults` has
  `status: "failed"`, `reason: "resume_unavailable"`,
  `outputs: null`, and `session_id: null`

#### Scenario: Skipped node is not appended

- **WHEN** node P has `max_iterations: 2` and has already
  executed twice, and the runner pops a third scheduled
  occurrence of P from its queue
- **THEN** the runner skips P without dispatch and SHALL NOT
  append a `priorResults` entry for that skipped occurrence
