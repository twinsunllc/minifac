## Why

The [[Runner]] passes the entire run-wide event history into every
scheduled node's prompt via the [[Executor]]'s stream-json input
preamble. That design has broken: the `run-history-persistence`
dogfood hit `"Prompt is too long"` at verify because apply's
accumulated stream-json events overflowed the 1M-token context
window. The dogfood had to be finished by hand.

Decision `docs/decisions/0014-Structured-Prior-Results.md` resolves
this. Nodes don't actually need each other's *transcripts* —
the only cross-node information needed for cycle iteration is
*what completed* and *why it failed*. The [[Sentinel]]'s REASON
line already carries the failure context; transcripts add noise
and cost without value.

This change replaces the run-wide event-history pass-through with
a structured `priorResults` array: one entry per completed node
execution, carrying `nodeId`, `iteration`, `status`, `reason`
(sentinel REASON when failed; else null), and timestamps. Per-node
prompts stay bounded regardless of run size. Raw events still
land in [[Runs-DB]] unchanged — that storage path is now the
canonical home for raw events.

## What Changes

- Replace the runner's `RunHistoryEntry[]` history accumulation
  with a `NodeResult[]` `priorResults` array. Each completed node
  execution appends exactly one entry, in completion order.
- Replace the executor's `RunContext.history` field with
  `RunContext.priorResults`.
- Update the claude executor's stream-json input preamble to
  serialize `priorResults` instead of the per-event history.
- Update the [[Runs-DB]] event log unchanged — raw events still
  persist there for future inspection.
- Sentinel REASON line is elevated from "nice to have" to
  load-bearing: it is the cycle-feedback mechanism.

## Capabilities

### Modified Capabilities

- `graph-runner`: the "run-wide history" requirement is replaced
  by a structured prior-results pass-through. Per-node `RunContext`
  carries a frozen snapshot of the `priorResults` array taken at
  scheduling time. One entry appended per completed node execution.
- `node-executor`: the claude executor's stream-json input preamble
  carries the `priorResults` array (not the run-wide event
  history). The `RunContext` interface field renames accordingly.

## Impact

- Touched code: `src/executor/types.ts` (rename `RunHistoryEntry`
  to `NodeResult`, swap `history` for `priorResults` on
  `RunContext`), `src/runner/run.ts` (build `priorResults`),
  `src/executor/claude.ts` (serialize `priorResults` instead of
  history; update wire-format comment block), and the wire-format
  snapshot test.
- Tests: runner tests assert prior-results accumulation instead of
  history accumulation; wire-format snapshot updated and pinned; a
  new cycle test verifies apply iter 2 sees verify iter 1's
  REASON in `priorResults`. All existing 329+ tests pass after
  the rename / shape change.
- Docs: `docs/concepts/Runner.md` (history → prior-results),
  `docs/concepts/Cycle.md` (history → results), and
  `docs/Open-Questions.md` (remove the resolved entry).
- No factory schema changes. No brief schema changes. No executor
  interface changes beyond the `RunContext` field name. No
  changes to event persistence in `runs.db`. No changes to
  streaming behavior to `onEvent` consumers (CLI, viewer). No
  changes to the [[Sentinel]] regex or format.
- Out of scope: any opt-in or declarative way for a node to
  access raw prior events (e.g. `receive_history`,
  `with: { history: [...] }`, per-node history filters). If a
  real consumer surfaces, it queries [[Runs-DB]] directly. See
  alternatives in `docs/decisions/0014-Structured-Prior-Results.md`.
