## ADDED Requirements

### Requirement: Resumed runs

The runner SHALL accept an optional `RunOptions.resume` of shape:

```ts
{
  at: string;                            // node to dispatch first
  priorResults: NodeResult[];            // the parked run's results
  iterations?: Record<string, number>;   // per-node counts already spent
  feedback?: string;                     // the human's answer
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
6. The seeded dispatch SHALL be EXEMPT from the seeded node's
   `max_iterations`. The exemption is one dispatch wide: every dispatch
   after it, including a later iteration of the same node reached along
   an edge, SHALL be checked normally against the rehydrated counters.
7. The runner SHALL start its edge-traversal counters EMPTY, so the
   seeded dispatch spends no `max_traversals` slot — it traverses no
   edge. An outbound edge whose budget was exhausted in the parked run
   is therefore traversable again in the resumed segment.
8. The runner SHALL emit a `runner-action` event naming the resumed
   node, its iteration, and the fact that the seed traverses no edge
   and is exempt from the node's `max_iterations`.
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

### Requirement: Resume feedback delivery

When `RunOptions.resume.feedback` is a non-empty string, the runner
SHALL deliver it to the resumed node through TWO channels:

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

### Requirement: `{{ run.feedback }}` run-scope token

The runner SHALL substitute `{{ run.feedback }}` under the existing
`run` token namespace with the run's feedback string, or with the
EMPTY STRING when the run has none.

Unlike `{{ run.cwd }}` and `{{ run.base_branch }}`, an absent value
SHALL NOT pass through verbatim: a step binding this token is asking
what a human said, "nobody said anything" is a real answer to that
question, and the literal token handed to a model reads as an
instruction. This matches the convention for a missing `inputs.*`
key. A string with no `run` namespace in scope at all still passes
through, which keeps the namespace rule intact.

#### Scenario: The token resolves to the answer on a resumed run

- **WHEN** a run is resumed with `feedback: "waive AC-13"` and a node's
  prompt is `"answer: {{ run.feedback }}"`
- **THEN** the executor receives `"answer: waive AC-13"`

#### Scenario: The token resolves to the empty string on an ordinary run

- **WHEN** a run with no resume state dispatches a node whose prompt
  is `"answer=[{{ run.feedback }}]"`
- **THEN** the executor receives `"answer=[]"`
