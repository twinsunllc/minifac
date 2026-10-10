## ADDED Requirements

### Requirement: Between-node boundary hook and park

The runner SHALL accept an optional
`RunOptions.onNodeBoundary(boundary) => "continue" | "park"` (sync or
async), where `boundary` is `{ nodeId, iteration, first }`: the node about
to be dispatched, the iteration it will have, and whether no node has been
dispatched yet in this run (for a resumed run, since it resumed). It SHALL
also accept `RunOptions.nodeBoundaryTimeoutMs`, defaulting to
`DEFAULT_NODE_BOUNDARY_TIMEOUT_MS` (10 000).

When no hook is supplied the runner SHALL behave exactly as it does
without this requirement. When one is supplied:

1. The runner SHALL call it at the queue head AFTER the dispatch is
   admitted — the node's `max_iterations` check passed (a dispatch the
   budget skips is not consulted) and its executor resolved — and BEFORE
   the iteration is spent, its outputs directory is created,
   `recordNodeStart` is called or the executor starts. Edges are budgeted
   by `max_traversals` when they are traversed, so a dispatch on the
   queue was already admitted by them.
2. It SHALL be called before the run's first dispatch, and at every later
   boundary. It is NOT called after a terminal node succeeds or after a
   node fails with no traversable recovery edge: there is no next
   dispatch.
3. It SHALL be called only when exactly one dispatch is pending (the
   queue is empty once the dispatch is taken from it). A boundary with
   more than one pending dispatch does not consult it and does not park;
   the run parks at the first later boundary with exactly one pending, or
   runs to its end.
4. When it returns `"park"`, the runner SHALL NOT dispatch the node, SHALL
   emit and persist a `runner-action` event naming it, and SHALL end the
   run with `status: "parked"`, `reason: "parked"`, `proximateNodeId` set
   to the node, and `parked: { nodeId, iteration, pending: [{ nodeId,
   iteration }], edgeTraversals }`. `edgeTraversals` holds the run's edge
   counts keyed `<from>-><to>:<when>`. The payload SHALL also carry
   `resumeSeed`: `true` when the parked dispatch was the seed of a resume
   that exempts its seed from `max_iterations` (an answer, quota or
   failed-run resume, or a pause resume with `resumeSeed: true`), so
   that a pause resume can grant that seed's privileges again, and
   `false` otherwise. The store row SHALL be finalized
   `parked`. Brief mark-done SHALL NOT run.
5. Any other return value is continue.
6. A hook that throws, rejects, or has not settled after
   `nodeBoundaryTimeoutMs` SHALL count as continue (fail open). The
   runner SHALL emit a `stderr` event naming the failure on the event
   stream and append it to the store, and SHALL consult the hook again at
   the next boundary.
7. A park SHALL NOT read or set `abortSignal`. If `abortSignal` fires
   while the hook runs, the runner SHALL end the run as the queue-head
   abort does (`user_quit`, no node) without dispatching.

#### Scenario: A park between two nodes

- **WHEN** a factory `A → B → C` runs with a hook that parks before `B`
- **THEN** only `A` is dispatched, the hook saw
  `{ nodeId: "A", iteration: 1, first: true }` then
  `{ nodeId: "B", iteration: 1, first: false }`, the result is `parked`
  naming `B` at iteration 1 with `edgeTraversals { "A->B:on_success": 1 }`,
  no node execution is recorded for `B`, and the run row is `parked`

#### Scenario: A park before the first dispatch

- **WHEN** a hook parks at its first call
- **THEN** nothing is dispatched and the result names the start node at
  iteration 1

#### Scenario: No hook, or a hook that always continues, changes nothing

- **WHEN** the same factory runs with no hook and with a hook that always
  returns `"continue"`
- **THEN** the dispatch sequence and the result (timings aside) are
  identical

#### Scenario: A failing hook fails open

- **WHEN** the hook throws, rejects, or never settles within
  `nodeBoundaryTimeoutMs`
- **THEN** every node is dispatched, the run succeeds, a `stderr` event
  names the hook failure at each boundary, and the hook is called at
  every boundary

#### Scenario: A fan-out boundary does not park

- **WHEN** `A` fans out to `B` and `C`, `C → D`, and the hook parks at
  every boundary after the first
- **THEN** the hook is not consulted for `B` (with `C` still pending),
  `B` is dispatched, and the run parks before `C`

#### Scenario: A park and a pause resume run the remaining nodes once

- **WHEN** a run of `A → B → C` parks before `B`, and a run is started
  with the state rebuilt from the store, `reason: "pause"` and the
  parked `edgeTraversals`
- **THEN** it dispatches `B` and `C` once each and never `A`

#### Scenario: Repeated pause and unpause do not reset a revise loop

- **WHEN** a loop `implement → review`, `review → implement` on failure
  with `max_traversals: 1`, parks before `implement` iteration 2 and is
  pause-resumed with the parked `edgeTraversals`
- **THEN** it dispatches `implement` and `review` once more and ends
  `budget_exhausted`, as the uninterrupted run does

## MODIFIED Requirements

### Requirement: Run termination

A run SHALL end with status `succeeded` when a terminal node completes
with status `succeeded`. A run SHALL end with status `failed` when:
(a) a node fails and no outbound `on_failure` edges remain traversable,
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

### Requirement: Run result is structured

When a run ends, the runner SHALL return a structured result containing:
overall status (`succeeded` | `failed` | `parked`), the reason for termination, the
sequence of nodes that executed (with per-node status and counts), and
the total run duration. A `parked` result SHALL also carry a `parked`
payload (`nodeId`, `iteration`, `pending`, `edgeTraversals`,
`resumeSeed`); no other
result carries one.

#### Scenario: Failed run result names the failed node

- **WHEN** node P fails and no recovery edge is available
- **THEN** the run result has `status: "failed"` and a reason that
  identifies P as the failing node

### Requirement: Resumed runs

The runner SHALL accept an optional `RunOptions.resume` of shape:

```ts
{
  at: string;                            // node to dispatch first
  priorResults: NodeResult[];            // the parked run's results
  iterations?: Record<string, number>;   // per-node counts already spent
  feedback?: string;                     // the human's answer
  reason?: "answer" | "pause";           // absent = "answer"
  resumedAt?: string;                    // carried run.resumed_at (pause only)
  edgeTraversals?: Record<string, number>; // keyed "<from>-><to>:<when>"
  resumeSeed?: boolean;                  // pause only: ParkedRun.resumeSeed
}
```

When `resume` is absent the runner SHALL behave exactly as it does
without this requirement. When `resume` is present:

1. If `at` does not name a node in the factory, the runner SHALL
   dispatch NOTHING and terminate the run `failed` with reason
   `resume_unknown_node`, emitting a `stderr` event naming `at` and
   listing the factory's node ids. Seeding a run at a node nobody
   declared would run an arbitrary node against a human's answer.
2. Otherwise the runner SHALL seed its queue with `at` ALONE. No
   declared start node (per the "Start-node identification"
   requirement) SHALL be dispatched.
3. The runner SHALL pre-fill `priorResults` with the supplied entries
   in the supplied order, so `{{ priorResults.<id>.outputs.<key>[:read] }}`,
   `{{ priorResults.<id>.status }}` and `{{ priorResults.<id>.reason }}`
   resolve in the resumed node's templates exactly as they resolved in
   the parked run.
4. The runner SHALL pre-fill its per-node iteration counters from
   `iterations`, taking for each node the greater of the supplied count
   and the highest `iteration` any supplied `priorResults` entry carries
   for that node. A negative or non-finite count, and a count for a node
   the factory does not declare, SHALL be ignored.
5. The seeded dispatch's iteration number SHALL therefore be the
   rehydrated count plus one.
6. On an ANSWER resume (`reason` absent or `"answer"`) the seeded
   dispatch SHALL be EXEMPT from the seeded node's `max_iterations`. The
   exemption is one dispatch wide: every dispatch after it, including a
   later iteration of the same node reached along an edge, SHALL be
   checked normally against the rehydrated counters. On a PAUSE resume
   (`reason: "pause"`) the seed SHALL get no exemption: it is checked
   against `max_iterations` like any dispatch, and a seed the budget
   refuses is skipped. The one exception is a pause resume with
   `resumeSeed: true`, which a caller passes when the run was parked
   before an answer, quota or failed-run resume's seed was dispatched
   (`ParkedRun.resumeSeed`): its seed SHALL be exempt as an answer
   resume's seed is, one dispatch wide. `resumeSeed` SHALL be ignored on
   an answer resume.
7. The runner SHALL start its edge-traversal counters from
   `edgeTraversals` when it is supplied, and EMPTY otherwise. A key that
   names no declared edge (`<from>-><to>:<when>`), and a negative or
   non-finite count, SHALL be ignored; a count is truncated to an
   integer. Either way the seeded dispatch spends no `max_traversals`
   slot — it traverses no edge. Without supplied counts, an outbound edge
   whose budget was exhausted in the parked run is therefore traversable
   again in the resumed segment; with them, it is not.
8. The runner SHALL emit a `runner-action` event naming the resumed
   node, its iteration, and the fact that the seed traverses no edge;
   on an answer resume it also states that the seed is exempt from the
   node's `max_iterations`, and on a pause resume that it is checked
   against it, or, with `resumeSeed: true`, that it is exempt.
9. When a store is supplied and it implements the optional
   `reopenRun`, the runner SHALL call `reopenRun(runId)` INSTEAD of
   `createRun`, so the resumed dispatches append to the run row that
   already exists. When the store does not implement it, the runner
   SHALL call `createRun` as it always does.

#### Scenario: The resumed node dispatches first and no start node runs

- **WHEN** a factory `plan → implement → evaluate` is run with
  `resume.at = "evaluate"` and `priorResults` for `plan` and
  `implement`
- **THEN** the only node dispatched is `evaluate`, and neither `plan`
  nor `implement` is dispatched

#### Scenario: Rehydrated prior results are readable from the resumed node

- **WHEN** the resumed node's `with.prompt` contains
  `{{ priorResults.plan.outputs.result:read }}` and the supplied
  `plan` entry's `outputs.result.path` names a readable file
- **THEN** the executor receives that file's contents inline

#### Scenario: The seed is exempt from `max_iterations` and the next dispatch is not

- **WHEN** a run is resumed at a node declaring `max_iterations: 2`
  with `iterations: { <node>: 2 }`, that node fails, and an
  `on_failure` edge routes to a node whose `on_success` edge routes
  back
- **THEN** the seeded dispatch runs as iteration 3, the successor
  runs, and the traversal back to the resumed node is refused by the
  rehydrated iteration budget, terminating the run
  `budget_exhausted`

#### Scenario: The seed spends no `max_traversals` slot

- **WHEN** a run is resumed at a node whose only outbound
  `on_failure` edge declares `max_traversals: 1`, and that edge was
  already traversed once in the parked run
- **THEN** the edge is traversed and its target dispatched

#### Scenario: An unknown resume node dispatches nothing

- **WHEN** `resume.at` names a node the factory does not declare
- **THEN** no node is dispatched and the run terminates `failed` with
  reason `resume_unknown_node`

#### Scenario: Supplied edge counts bound the resumed segment

- **WHEN** a run is resumed with
  `edgeTraversals: { "evaluate->rescue:on_failure": 1 }` at a node whose
  only outbound `on_failure` edge to `rescue` declares
  `max_traversals: 1`, and that node fails
- **THEN** the edge is refused and the run terminates `budget_exhausted`

#### Scenario: A pause resume's seed takes no max_iterations exemption

- **WHEN** a run is resumed with `reason: "pause"` at a node declaring
  `max_iterations: 1` with `iterations: { <node>: 1 }`
- **THEN** the seed is not dispatched and the run terminates
  `budget_exhausted`; the same resume without `reason` dispatches the
  seed as iteration 2

#### Scenario: A park before an answer resume's seed keeps its privileges

- **WHEN** an answer resume (`feedback: "approved"`) of a node declaring
  `max_iterations: 1` with `iterations: { <node>: 1 }` is parked by the
  boundary hook before its seed, and is then resumed with
  `reason: "pause"`, the same `feedback` and `resumeSeed: true` from the
  park
- **THEN** the park reports `resumeSeed: true`; the pause resume
  dispatches the seed as iteration 2 with the human-answer block and the
  run reaches its terminal node; without `resumeSeed` the pause resume
  terminates `budget_exhausted`

### Requirement: Resume feedback delivery

When `RunOptions.resume.feedback` is a non-empty string and the resume
is an ANSWER resume (`reason` absent or `"answer"`), the runner SHALL
deliver it to the resumed node through TWO channels:

1. As the value of the `{{ run.feedback }}` token, for the WHOLE
   resumed run (see the "`{{ run.feedback }}` run-scope token"
   requirement).
2. As a delimited human-answer block appended to the SEEDED
   dispatch's `with.prompt`, when that prompt is a string. The block
   SHALL begin with the heading `## Human answer (resume)`, SHALL
   carry the answer verbatim between fence lines, and SHALL be
   appended AFTER template substitution so that no token-shaped text
   in a human's answer is substituted.

The block SHALL be appended to the seeded dispatch ONLY. A later
iteration of the same node, reached along an edge, SHALL NOT carry
it — it can still read the answer through the run-wide token.

A node whose `with.prompt` is absent or not a string SHALL be
dispatched unchanged; there is nowhere to append to.

On a PAUSE resume (`reason: "pause"`) `feedback` is the parked run's own
`{{ run.feedback }}`, carried over, not a new answer. The runner SHALL
render it through the token only and SHALL append NO human-answer block,
unless the pause resume carries `resumeSeed: true`: the run was parked
before an answer resume's seed was dispatched, so `feedback` is that
answer, and the runner SHALL append the block to the seed as the answer
resume would have.

#### Scenario: Both channels reach a node that binds the token

- **WHEN** a run is resumed at a node whose prompt contains
  `{{ run.feedback }}` with `feedback: "waive AC-13, verify after deploy"`
- **THEN** the dispatched prompt contains the substituted answer AND
  the `## Human answer (resume)` block

#### Scenario: The injected block reaches a node that binds no token

- **WHEN** a run is resumed at a node whose prompt contains no
  `{{ run.feedback }}` token
- **THEN** the dispatched prompt still contains the
  `## Human answer (resume)` block with the answer verbatim

#### Scenario: The injected block is not repeated on a later iteration

- **WHEN** the resumed node fails, routes away and is reached again
  as iteration 2
- **THEN** iteration 2's prompt contains the substituted
  `{{ run.feedback }}` value but NOT the `## Human answer (resume)`
  block

#### Scenario: A pause resume appends no block

- **WHEN** a run is resumed with `reason: "pause"` and
  `feedback: "earlier answer"` at a node whose prompt is
  `"feedback=[{{ run.feedback }}]"`
- **THEN** the dispatched prompt is `"feedback=[earlier answer]"` and
  contains no `## Human answer (resume)` block

### Requirement: Resume-seed, follow-up and prior-asks run-scope tokens

The runner SHALL accept an optional `RunOptions.followUp` of shape:

```ts
{
  priorAsks?: unknown[];   // passed through as JSON, not interpreted
}
```

`followUp` SHALL NOT change which nodes are dispatched: a follow-up run
starts at its declared start nodes exactly as a run without it does.

The runner SHALL substitute three tokens under the existing `run`
namespace for EVERY run, with the same empty-not-verbatim convention as
`{{ run.feedback }}`:

1. `{{ run.resumed_at }}` — the id of the node a resumed run was seeded
   with (`RunOptions.resume.at`), or the EMPTY STRING when the run was
   not resumed. On a pause resume (`resume.reason: "pause"`) it SHALL be
   `resume.resumedAt`, or the EMPTY STRING when that is absent: the run
   carries on with the value it was parked with, so a gate comparing its
   own id to `run.resumed_at` sees what it saw before the park.
2. `{{ run.follow_up }}` — `true` when `RunOptions.followUp` is present,
   otherwise `false`.
3. `{{ run.prior_asks }}` — `JSON.stringify(followUp.priorAsks)`, or
   `[]` when `followUp` or its `priorAsks` is absent.

`{{ run.feedback }}` keeps its whole-run semantics (see the "Resume
feedback delivery" requirement). A node re-dispatched DOWNSTREAM of a
resume seed therefore still reads the answer through `run.feedback`,
and reads the seed's id, not its own, through `run.resumed_at`. That is
how a gate re-run after a re-plan tells "the human answered me" from
"the human's answer re-planned upstream of me".

#### Scenario: A gate downstream of a re-plan seed sees the seed's id

- **WHEN** a factory `plan → plan_gate → implement` is resumed with
  `resume.at = "plan"` and `feedback: "only the API half"`, and
  `plan_gate`'s prompt is
  `"resumed_at=[{{ run.resumed_at }}] feedback=[{{ run.feedback }}]"`
- **THEN** `plan`'s prompt carries the `## Human answer (resume)` block,
  `plan_gate` is dispatched (not skipped) with the prompt
  `"resumed_at=[plan] feedback=[only the API half]"`, and `plan_gate`'s
  prompt carries no `## Human answer (resume)` block

#### Scenario: A follow-up run renders the flag and the prior asks

- **WHEN** a run is started with
  `followUp: { priorAsks: [{ node_id: "plan_gate", ... }] }` and a start
  node's prompt is `"fu={{ run.follow_up }} asks={{ run.prior_asks }}"`
- **THEN** the executor receives `fu=true` and the JSON of `priorAsks`

#### Scenario: An ordinary run renders the none-values

- **WHEN** a run with neither `resume` nor `followUp` dispatches a node
  whose prompt is
  `"at=[{{ run.resumed_at }}] fu={{ run.follow_up }} asks={{ run.prior_asks }}"`
- **THEN** the executor receives `"at=[] fu=false asks=[]"`

#### Scenario: A pause resume renders the carried resumed_at

- **WHEN** a run is resumed with `resume.at = "evaluate"`,
  `reason: "pause"` and `resumedAt: "plan"`, and `evaluate`'s prompt is
  `"resumed_at=[{{ run.resumed_at }}]"`
- **THEN** the executor receives `"resumed_at=[plan]"`; without
  `resumedAt` it receives `"resumed_at=[]"`
