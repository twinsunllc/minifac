## ADDED Requirements

### Requirement: Node iteration and entering-edge tokens

The simple namespace token grammar of "Brief token substitution before
node dispatch" SHALL recognize two more namespaces, `node` and `edge`,
resolved in the same dispatch-time pass and on the same fields
(`with.prompt`, `with.base`, `cwd`, and so any `inputs:` binding that
step inlining placed in one of them).

- `node.iteration`: the dispatch's 1-based iteration, the same number
  its outputs directory (`<node-id>/<iteration>`), its store row and its
  event tags carry.
- `edge.traversals`: the traversal count of the edge that queued this
  dispatch, INCLUDING the traversal that queued it. The count SHALL be
  taken when the edge is traversed, so a later traversal of the same
  edge before this dispatch runs does not change it. A dispatch no edge
  queued (a start node, or a resume seed with no entering edge) SHALL
  render `0`.
- `edge.max_traversals`: that edge's `max_traversals`, or the empty
  string when the edge declares none or no edge queued the dispatch.
- Any other field under `node` or `edge` (e.g. `node.foo`,
  `edge.bar`), and any dotted sub-path (e.g. `node.iteration.x`), SHALL
  be left verbatim with no error, the convention for unknown `brief.*`
  and `run.*` fields.
- Load-time step inlining (`substituteInputs`) SHALL leave `node.*` and
  `edge.*` tokens verbatim, including one an input value carries, so
  they resolve at dispatch.
- A caller of `substitute` that supplies no `node` (resp. `edge`) scope
  SHALL see `node.*` (resp. `edge.*`) tokens verbatim. The runner always
  supplies both.

Park and resume SHALL keep the counts:

- `ParkedRun` SHALL carry `via`, the `<from>-><to>:<when>` key of the
  edge that queued the parked dispatch, absent when no edge did; each
  `pending` entry SHALL carry the same `via`.
- `ResumeState` SHALL accept an optional `via`. When it names a
  declared edge whose `to` is `at`, the seed SHALL render
  `edge.traversals` as that edge's count after `edgeTraversals`
  rehydration (the seed traverses no edge, so nothing is added) and
  `edge.max_traversals` as that edge's budget. Otherwise the seed
  SHALL render `0` and the empty string.
- The seed's `node.iteration` SHALL be its iteration per "Resumed
  runs" (the rehydrated count plus one), the iteration the parked or
  escalated dispatch would have had.
- `resumeStateFromStore` SHALL NOT set `via`: the run store does not
  record a dispatch's entering edge.

#### Scenario: A three-pass loop

- **WHEN** start node `work` (prompt
  `"iter={{ node.iteration }} trav={{ edge.traversals }} max={{ edge.max_traversals }}"`)
  feeds `check`, `check → work` is `on_failure` with `max_traversals: 2`,
  and `check` fails twice then succeeds
- **THEN** `work`'s prompts are `"iter=1 trav=0 max="`,
  `"iter=2 trav=1 max=2"` and `"iter=3 trav=2 max=2"`

#### Scenario: A budget-less entering edge

- **WHEN** start node `A` feeds `B` along an edge with no
  `max_traversals`
- **THEN** `A` renders `trav=0 max=` and `B` renders `trav=1 max=`

#### Scenario: A pause resume keeps the counts

- **WHEN** the three-pass loop parks before `work`'s third dispatch and
  is resumed with the park's `edgeTraversals`, `via` and
  `reason: "pause"`
- **THEN** `parked.via` is `"check->work:on_failure"` and the resumed
  prompt is `"iter=3 trav=2 max=2"`

#### Scenario: An answer resume without `via`

- **WHEN** a run is resumed at `work` from the store after `work` ran
  twice
- **THEN** the seed renders `"iter=3 trav=0 max="`

#### Scenario: A `via` that does not enter the seed is ignored

- **WHEN** `ResumeState.via` names no declared edge, or a declared edge
  whose `to` is not `at`
- **THEN** the seed renders `trav=0 max=`

#### Scenario: Through a `uses:` binding and in `cwd`

- **WHEN** a `uses:` node binds an input to
  `"{{ node.iteration }} of edge {{ edge.traversals }}/{{ edge.max_traversals }}"`
  and declares `cwd: "{{ run.cwd }}/i{{ node.iteration }}"`
- **THEN** the loaded prompt still carries the tokens, and each dispatch
  receives its own iteration and counts in the prompt and `cwd`

#### Scenario: Unknown field

- **WHEN** a prompt carries `{{ node.foo }} {{ edge.bar }} {{ node.iteration.x }}`
- **THEN** the executor receives it unchanged and the run is not failed
