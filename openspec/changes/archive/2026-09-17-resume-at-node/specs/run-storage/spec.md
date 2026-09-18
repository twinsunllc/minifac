## ADDED Requirements

### Requirement: Resume-state reconstruction

The `RunStore` interface SHALL declare two further OPTIONAL methods
and one further read option:

- `getNodeExecutions(runId): Promise<NodeExecutionRow[]>` — every
  `node_executions` row of a run, carrying `nodeId`, `iteration`,
  `status` (`running` | `succeeded` | `failed` | `skipped`),
  `startedAt`, `endedAt` and `sessionId`.
- `reopenRun(runId): Promise<void>` — put a finished run back to
  `running`, clearing `ended_at`, `reason` and `proximate_node_id`, so
  a resumed segment appends to the same row. A no-op for an unknown
  run id.
- `GetEventsOptions.kind` — return only events of the named kind. A
  HINT: an adapter that cannot filter MAY ignore it, so a caller that
  needs the guarantee filters again.

Both methods are OPTIONAL for the same reason
`deleteNodeOutputsForRun` is: the droid's adapter in
twinsunllc/scarif-worker is assignable to this interface by shape
alone, and a required method would break its build the moment this
one shipped. The SQLite adapter SHALL implement all three.

`resumeStateFromStore({ store, runId, at, feedback })` SHALL rebuild a
finished run's `ResumeState` from those rows:

- One `priorResults` entry per node, from that node's LATEST ENDED
  iteration — the same latest-wins rule the runner's own prior-results
  map applies. A `running` or `skipped` row contributes no entry.
- Each entry's `outputs` SHALL be the `NodeOutputIndex` assembled from
  the `node_outputs` rows of that exact `(node, iteration)`, or `null`
  when there are none.
- Each entry's `reason` SHALL be recovered from the run's persisted
  `status` events for that `(node, iteration)`, applying the same
  extraction rule the runner applies live (a `sentinel_failed` meta's
  `sentinel` string, else a categorical `meta.reason`); `null` for a
  succeeded node and for a failed node whose status event is no longer
  in the log. `node_executions` has no reason column, and
  `{{ priorResults.<id>.reason }}` is exactly what an
  escalation-aware step reads, so dropping it would rebuild a worse
  state than the run had.
- Each entry's `startedAt` / `endedAt` SHALL be rebased onto
  ms-since-run-start, so a rehydrated entry is on the same scale as
  one the resumed run produces itself.
- `iterations` SHALL carry, per node, the HIGHEST iteration any row
  mentions — including a `running` or `skipped` row, because that
  dispatch still spent its slot.
- `feedback` SHALL be carried when supplied and the key SHALL be
  ABSENT when it is not.

An unknown run id, and a store that does not implement
`getNodeExecutions`, SHALL each raise `ResumeStateError` with a
sentence naming the problem.

#### Scenario: A finished run's state is rebuilt

- **WHEN** a run's store holds `plan` iterations 1 (failed) and 2
  (succeeded, with a `result` output) and `evaluate` iteration 1
  (failed, status event carrying sentinel
  `"escalate: AC-13 cannot be proved pre-merge"`)
- **THEN** `resumeStateFromStore` returns two `priorResults` entries —
  `plan` at iteration 2 with its outputs index, and `evaluate` at
  iteration 1 with `reason: "escalate: AC-13 cannot be proved pre-merge"` —
  and `iterations` `{ plan: 2, evaluate: 1 }`

#### Scenario: A skipped node contributes an iteration count but no result

- **WHEN** a run's store holds only a `skipped` row for node `verify`
- **THEN** `iterations.verify` is that row's iteration and no
  `priorResults` entry names `verify`

#### Scenario: A finished run is reopened

- **WHEN** `reopenRun` is called for a run whose row is `failed` with
  a reason, a proximate node and an `ended_at`
- **THEN** the row reads `status: "running"` with all three cleared

#### Scenario: An unknown run id is refused

- **WHEN** `resumeStateFromStore` is called with a run id the store
  does not hold
- **THEN** it raises `ResumeStateError` naming the id
