## ADDED Requirements

### Requirement: Optional `RunStore` persistence

The runner SHALL accept an optional `store` argument implementing
the `run-storage` capability's `RunStore` interface. When `store`
is provided, the runner SHALL persist run state and events
through it; when `store` is absent, the runner SHALL behave
exactly as it does today (used by unit tests and any caller that
doesn't care about persistence).

When a `store` is in scope, the runner SHALL:

1. Immediately before the first node is dispatched, generate a
   run id and invoke `store.createRun(...)` with the run's
   starting metadata. The metadata SHALL include at minimum:
   the factory's absolute path, the factory's declared `name`,
   the brief's source path and `change` (when a brief is in
   scope), the `runCwd` value (as `worktreePath` for worktree-
   mode runs and as `null` when no `runCwd` is set), the
   `base_branch` from the brief (when present), and the run's
   `startedAt` epoch-ms timestamp.
2. For every event the runner records into run-wide history, in
   the same order, invoke `store.appendEvent(runId, ...)`. The
   in-memory history and the durable event log SHALL stay
   structurally consistent; the runner SHALL NOT drop events
   from one and keep them in the other.
3. Bracket each node dispatch with `store.recordNodeStart(...)`
   before the executor is invoked and `store.recordNodeEnd(...)`
   after the node terminates (including when the node is skipped
   for budget reasons).
4. When the run terminates (success, failure, or budget
   exhaustion), invoke `store.finalizeRun(runId, ...)` with the
   terminal status, reason, proximate node id (when known), and
   the `endedAt` epoch-ms timestamp.

Store calls SHALL NOT swallow runner-fatal errors but SHALL NOT
themselves abort the run on transient persistence failures; a
store-level error SHALL be surfaced to the caller via the run's
emitted events (a synthetic `stderr` line) so the run still
completes the in-memory contract. The exact failure semantics
of the v0 SQLite adapter (transactions per-row, retries) are
specified in the `run-storage` capability.

#### Scenario: Run without a store behaves identically to today

- **WHEN** `runFactory(...)` is invoked without a `store` argument
  on a factory that succeeds today
- **THEN** the run completes with the same `RunResult` it does
  today; no persistence call is attempted

#### Scenario: Store is created at the start, finalized at the end

- **WHEN** `runFactory(loaded, { store, brief, runCwd, ... })`
  is invoked and the run reaches a terminal node `succeeded`
- **THEN** `store.createRun` is called exactly once before the
  first node dispatch (with the brief's `change` set on the
  stored run), `store.appendEvent` is called once per emitted
  event in order, and `store.finalizeRun` is called exactly
  once with `status: "succeeded"` after the terminal node
  completes

#### Scenario: Stored event seq matches in-memory history order

- **WHEN** a run emits five events
- **THEN** the store's `getRunEvents(runId)` returns those five
  events with `seq` values `0, 1, 2, 3, 4` in the same order
  the runner's `onEvent` consumer saw them

#### Scenario: Brief-less run records null brief / change

- **WHEN** a brief-less factory invocation runs with a store in
  scope
- **THEN** the stored run's `briefPath` and `change` are both
  `null`; `factoryName` is still populated from the factory's
  declared `name`

#### Scenario: Failed run finalizes with structured reason

- **WHEN** a run terminates `failed` with reason
  `budget_exhausted` and proximate node `verify`
- **THEN** `store.finalizeRun` is invoked with
  `status: "failed"`, `reason: "budget_exhausted"`,
  `proximateNodeId: "verify"`, and an `endedAt` timestamp;
  the corresponding stored run row reflects those values
