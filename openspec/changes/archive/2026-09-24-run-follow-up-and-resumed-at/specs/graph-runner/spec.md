## ADDED Requirements

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
   not resumed.
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
