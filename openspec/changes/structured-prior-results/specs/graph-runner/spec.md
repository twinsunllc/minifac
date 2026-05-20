## ADDED Requirements

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
}
```

When a node is scheduled, the runner SHALL pass a read-only,
frozen snapshot of the `priorResults` array through the executor's
run context as `ctx.priorResults`. Subsequent iterations of the
same node in a cycle SHALL therefore receive their own prior
result entries (and the entries of every other node that ran in
between).

The `reason` field SHALL be populated from the executor's terminal
`status` event `meta` payload: when `meta.reason === "sentinel_failed"`
and `meta.sentinel` is a string, `reason` SHALL be that string
(trimmed of trailing whitespace). In all other cases (successful
executions, non-sentinel failures), `reason` SHALL be `null`.

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
  endedAt: <ms> }`

#### Scenario: A node's second iteration sees its first iteration's result

- **WHEN** node P runs (iteration 1) and succeeds, then node V
  runs and fails with a sentinel REASON of `"verify hit error"`,
  then the runner cycles back to P for iteration 2
- **THEN** the run context passed to P on iteration 2 contains
  `priorResults` with two entries in order: P iter 1 (status
  `succeeded`, `reason: null`), then V iter 1 (status `failed`,
  `reason: "verify hit error"`)

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
  "failed"` and `reason: null`

#### Scenario: Skipped node is not appended

- **WHEN** node P has `max_iterations: 2` and has already
  executed twice, and the runner pops a third scheduled
  occurrence of P from its queue
- **THEN** the runner skips P without dispatch and SHALL NOT
  append a `priorResults` entry for that skipped occurrence

## REMOVED Requirements

### Requirement: Run-wide history is accumulated and passed to each node

**Reason**: The run-wide event-history pass-through was the wrong
shape — it sent each downstream node a transcript of every prior
event, which inflated prompts past the model's context window
(the `run-history-persistence` dogfood hit `"Prompt is too long"`
at verify). The actual cross-node information needed for cycle
iteration is *what completed* and *why it failed*; that fits in
a structured `NodeResult` entry, not a per-event transcript. See
`docs/decisions/0014-Structured-Prior-Results.md`.

**Migration**: Replaced by the "Prior-results accumulate across
node executions" requirement above. The `RunContext.history` field
is renamed to `RunContext.priorResults` and changes shape from
`readonly RunHistoryEntry[]` to `readonly NodeResult[]`. Raw
events still persist in [[Runs-DB]] (see `run-storage`
capability) — they are no longer pushed into per-node prompts.
Consumers that need raw events query the Runs-DB directly.
