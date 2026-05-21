---
change: structured-prior-results
factory: sdd
base_branch: main
---

## Background

The [[Runner]] currently passes the entire run-wide event history into
every scheduled node's prompt via the [[Executor]]'s stream-json input
preamble. This is the wrong shape and already broke once — the
`run-history-persistence` dogfood hit "Prompt is too long" because
apply's accumulated events overflowed verify's context window.

The decision and rationale are captured in
`docs/decisions/0014-Structured-Prior-Results.md`. Read it first.

## What to do

Read:

- `docs/decisions/0014-Structured-Prior-Results.md` — binding decision
- `docs/concepts/Runner.md` — runner concept (will need updating)
- `docs/concepts/Cycle.md` — cycle concept (will need updating)
- `docs/concepts/Sentinel.md` — REASON line is now load-bearing
- `docs/concepts/Runs-DB.md` — raw events persist here unchanged
- `openspec/specs/graph-runner/spec.md` — has the "Run-wide history is
  accumulated and passed to each node" requirement; needs MODIFIED
- `openspec/specs/node-executor/spec.md` — claude executor's wire
  format scenario references run history; needs MODIFIED
- `src/runner/run.ts` — accumulates `history`, snapshots it into ctx
- `src/executor/claude.ts` — serializes `ctx.history` into stream-json
- `src/runner/substitute.ts` and the templating doc — confirm no
  templating tokens depend on history (`{{ brief.* }}` and
  `{{ run.* }}` should be unaffected)

Then implement:

### 1. Runner: build `priorResults` instead of `history`

- Replace the `RunHistoryEntry[]` history accumulation with a
  `NodeResult[]` `priorResults` array. Each entry:

      {
        nodeId: string,
        iteration: number,
        status: "succeeded" | "failed",
        reason: string | null,     // sentinel REASON if failed; null otherwise
        startedAt: number,         // ms since run start
        endedAt: number,
      }

- Append exactly one entry per node execution when the node terminates
  (succeeded or failed). Do not append per-event.
- Continue capturing all events into the [[Runs-DB]] unchanged — that
  storage path is now the canonical home for raw events.
- Each scheduled node's `RunContext` carries a frozen snapshot of
  `priorResults` taken at scheduling time.
- The cycle re-entry case still works: apply iter 2 sees apply iter 1
  + verify iter 1 entries in `priorResults`. The REASON on verify
  iter 1's entry is what tells apply why it's being scheduled again.

### 2. Executor: serialize `priorResults`, not `history`

- The claude executor's stream-json input preamble currently is a
  single user-message with content `<history JSON>\n\n---\n\n<prompt>`.
  Change to `<priorResults JSON>\n\n---\n\n<prompt>`.
- The wire-format comment block at the top of `src/executor/claude.ts`
  needs updating to describe the new shape.
- Update the wire-format snapshot test so the new format is pinned.

### 3. Types

- `src/executor/types.ts` currently exports `RunHistoryEntry` and
  references it in `RunContext`. Replace with `NodeResult` and
  `priorResults`. Either rename in place (preferred — fewer exports
  to maintain) or keep `RunHistoryEntry` as an alias for one release
  to soften the transition. Pick the cleaner path.
- The factory schema, node-executor interface, brief schema are not
  affected.

### 4. Specs

- `graph-runner`: MODIFIED requirement currently titled "Run-wide
  history is accumulated and passed to each node" — rename and rewrite
  to reflect prior-results semantics. Update the three scenarios:
  - "History accumulates across nodes" → "Prior-results accumulate
    across nodes" (one entry per completed node execution, in
    completion order)
  - "A node's second iteration sees its first iteration" → "A node's
    second iteration sees its first iteration's result" (entry with
    the REASON if failed)
  - "History snapshot is stable for the duration of a node run" →
    stays in spirit; applies to `priorResults` now
- `node-executor`: MODIFIED scenarios under "Claude executor uses
  stream-json for both input and output" — specifically the "Run
  history is sent on stdin as stream-json" scenario becomes "Prior
  results are sent on stdin as stream-json."
- Add scenarios that lock in the prior-results shape (the JSON keys
  match the type definition exactly).

### 5. Tests

- The runner test suite has tests asserting history accumulation; they
  need to assert prior-results accumulation instead. The same
  scenarios still cover the spec — they just check a different field.
- The claude executor's wire-format snapshot test needs updating to
  the new preamble.
- Add a test that verifies the cycle case: `apply` iter 2 receives
  `priorResults` containing apply iter 1 + verify iter 1 entries,
  with verify's `reason` populated from the sentinel REASON.
- All existing 329 tests should otherwise still pass after the
  rename / shape change.

### 6. Docs

- Update `docs/concepts/Runner.md`: the "History pass-through"
  section becomes "Prior-results pass-through." Describe the new
  shape; cross-link to [[0014-Structured-Prior-Results]].
- Update `docs/concepts/Cycle.md`: the "History accumulates across
  iterations" section becomes "Results accumulate across iterations."
  Make clear that the REASON line is the cycle-feedback mechanism.
- Update `docs/Open-Questions.md`: remove the "Run-wide history
  exceeds context window" entry — it's resolved by this change.

## Out of scope

- **Any opt-in or declarative way for a node to access raw prior
  events.** See [[0014-Structured-Prior-Results]]'s alternatives
  section. If a real consumer surfaces later, it can query
  [[Runs-DB]] directly. Do not introduce a `receive_history` knob,
  `with: { history: [...] }`, or similar.
- **Changes to how events are persisted in `runs.db`.** That storage
  is unchanged — it remains the canonical home for raw events.
- **Changes to the [[Sentinel]] format or regex.** The REASON line
  is exactly the existing format; this change just elevates it to
  load-bearing.
- **Streaming-events behavior to consumers (CLI, viewer).** The
  runner still forwards every event to the `onEvent` consumer in
  real time. Only the per-node *prompt preamble* changes.

## Acceptance criteria

- The runner produces a `priorResults` array shaped per the spec
- The claude executor's stream-json input preamble carries
  `priorResults`, not the event history
- `examples/sdd.yaml`'s verify → apply on_failure cycle still iterates
  correctly: apply iter 2 sees verify iter 1's REASON in
  `priorResults` and addresses the failure
- Per-node prompt size no longer grows with the size of prior work
  (a run with 1000 stdout events from apply doesn't inflate verify's
  prompt)
- All 329+ existing tests pass after the rename / shape change
- The wire-format snapshot test is updated and locked
- `docs/Open-Questions.md` no longer has the history-bloat entry
- `docs/concepts/Runner.md` and `docs/concepts/Cycle.md` reflect
  the new pass-through semantics

## Why this is worth dogfooding

This is the change that closes the loop on the context-window failure
we hit on the last Phase 3 dogfood. Once it lands, future dogfoods
should stop hitting that ceiling regardless of run size.
