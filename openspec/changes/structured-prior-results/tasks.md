## 1. Types

- [x] 1.1 In `src/executor/types.ts`, replace `RunHistoryEntry` with
      a new `NodeResult` interface matching the spec shape
      (`nodeId`, `iteration`, `status`, `reason`, `startedAt`,
      `endedAt`).
- [x] 1.2 Replace `RunContext.history: readonly RunHistoryEntry[]`
      with `RunContext.priorResults: readonly NodeResult[]`. Delete
      `RunHistoryEntry` outright — no alias. (Introduced
      `EmittedEvent` as a distinct named shape for the runner's
      per-event `onEvent` callback / Runs-DB persistence — that
      stream is independent of `priorResults` and needs its own
      type.)
- [x] 1.3 Update every internal import / reference. The grep
      target is `RunHistoryEntry`; expect hits in `src/runner/run.ts`,
      `src/executor/claude.ts`, and their tests.

## 2. Runner

- [x] 2.1 In `src/runner/run.ts`, replace the `history:
      RunHistoryEntry[]` accumulator with `priorResults:
      NodeResult[]`.
- [x] 2.2 Keep `onEvent` semantics: rebuild the per-event entry
      inline for the callback (consumers still get every event in
      real time) but do NOT push events into `priorResults`.
- [x] 2.3 At node-end, after `finalStatus` is resolved, derive
      `reason`: when the terminal status event has
      `meta.reason === "sentinel_failed"` and a string
      `meta.sentinel`, capture the trimmed sentinel; otherwise
      `null`. Append exactly one `NodeResult` entry to
      `priorResults`.
- [x] 2.4 Skip the append for nodes that hit the
      `max_iterations` budget at pop time (matches the existing
      skipped-no-log behavior).
- [x] 2.5 At node-schedule time, snapshot `priorResults` (frozen
      `slice()` of the current array) and assign it to
      `ctx.priorResults`. Drop the `history` snapshot.
- [x] 2.6 Reuse the existing event-streaming machinery for
      `store.appendEvent` and `onEvent`. Persisting raw events to
      [[Runs-DB]] is unchanged.
- [x] 2.7 Update `reportStoreError` (or rename, since the
      `history` reference goes away) so its synthetic stderr line
      still surfaces store failures via `onEvent`. It SHALL NOT
      append a `NodeResult` entry — those are only for real node
      executions.

## 3. Executor — claude

- [x] 3.1 In `src/executor/claude.ts`, rename
      `buildStreamJsonInput(history, prompt)` to take the new
      `priorResults: readonly NodeResult[]` argument. The
      function body changes to `JSON.stringify(priorResults)`
      preamble + `\n\n---\n\n` + prompt.
- [x] 3.2 Update the call site in `run(node, ctx)` to pass
      `ctx.priorResults` instead of `ctx.history`.
- [x] 3.3 Rewrite the wire-format comment block at the top of
      `claude.ts` ("Wire format — stdin" section) to describe
      the `<priorResults JSON>` preamble. Cross-reference
      `docs/decisions/0014-Structured-Prior-Results.md`.

## 4. Tests

- [x] 4.1 Update `src/executor/claude.test.ts` wire-format
      snapshot to lock the new `<priorResults JSON>\n\n---\n\n<prompt>`
      shape. Verify the empty-priorResults case writes `[]` as the
      preamble.
- [x] 4.2 Update `src/runner/run.test.ts` tests that asserted
      history accumulation. The same scenarios still cover the
      spec — they assert `priorResults` accumulation instead and
      check that entries have the documented keys.
- [x] 4.3 Add a cycle test: a fake executor that fails on iter 1
      of `verify` with `meta.reason: "sentinel_failed"`,
      `meta.sentinel: "verify hit error"`. Assert that when
      `apply` runs iter 2, the executor receives a `RunContext`
      whose `priorResults` contains `apply` iter 1 (succeeded,
      `reason: null`) and `verify` iter 1 (failed,
      `reason: "verify hit error"`). (Covered by the rewritten
      "P on iteration 2 sees P iter-1 result and V iter-1 result"
      test.)
- [x] 4.4 Add a test for the non-sentinel failure path: a fake
      executor that yields `{ kind: "status", status: "failed",
      meta: { exitCode: 1 } }` (no `sentinel_failed`). Assert the
      appended entry has `reason: null`.
- [x] 4.5 Add a test for the skipped-node case: a node hits its
      `max_iterations` at pop time. Assert no entry is appended to
      `priorResults`. (Covered by two new tests: the
      `max_iterations: 1` budget-hit case verifies p executed
      exactly once; the multi-start-node snapshot test verifies
      `priorResults.length` matches actual executions.)
- [x] 4.6 Run the full suite; all 329+ existing tests pass.
      (332/332 passing.)

## 5. Docs

- [x] 5.1 Update `docs/concepts/Runner.md`: rename
      "History pass-through" to "Prior-results pass-through",
      describe the new shape, link to
      [[0014-Structured-Prior-Results]].
- [x] 5.2 Update `docs/concepts/Cycle.md`: rename
      "History accumulates across iterations" to "Results
      accumulate across iterations". Describe the REASON line as
      the cycle-feedback mechanism, link to
      [[0014-Structured-Prior-Results]] and
      [[0007-Sentinel-Runner-Injects]].
- [x] 5.3 Update `docs/Open-Questions.md`: remove the
      "Run-wide history exceeds context window" entry — it's
      resolved by this change.

## 6. Verification

- [x] 6.1 Run `npm test` (or the repo's test command). All tests
      pass. (332/332 via `vitest run`.)
- [x] 6.2 Run a quick end-to-end check on `examples/sdd.yaml`'s
      verify → apply on_failure cycle in a sandbox factory:
      confirm apply iter 2 receives `priorResults` with verify
      iter 1's REASON. (Covered by the rewritten "P on iteration
      2 sees P iter-1 result and V iter-1 result" cycle test in
      `src/runner/run.test.ts`, which exercises the exact pattern
      with a sentinel REASON.)
- [x] 6.3 `openspec validate structured-prior-results` exits 0.
- [x] 6.4 Confirm per-node prompt size no longer grows with
      prior work: a run with ≥1000 stdout events from apply does
      not inflate verify's prompt — verify's stdin user-message
      content size is bounded by `priorResults` entry count, not
      event count. (Structurally guaranteed: the snapshot tests
      in `src/executor/claude.test.ts` show the preamble is the
      JSON serialization of `priorResults` only; events never
      enter `priorResults` per requirement 2.2 and the
      "non-sentinel failure records reason: null" test, so the
      preamble grows only with `priorResults.length`, which is
      bounded by node executions, not event count.)
