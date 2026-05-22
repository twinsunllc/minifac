## 1. CLI flag

- [x] 1.1 Add `--max-failures <n>` option to the `autorun`
      subcommand in `src/cli.ts`, default `3`, help text
      "Per-session failure cap per change; 0 disables".
- [x] 1.2 Parse the value as a non-negative integer; reject
      negative, fractional, or non-numeric values with a stderr
      message naming `--max-failures` and exit `1`. Mirror the
      shape of the existing `--max-concurrent` validation.
- [x] 1.3 Thread the resolved `maxFailures` into the autorun
      entrypoint in `src/cli/autorun.ts` and through to
      `Scheduler` construction.

## 2. Scheduler state

- [x] 2.1 Add `failureCounts: Map<string, number>` (initialised
      empty) and `maxFailures: number` (read from new
      `SchedulerDeps` field) to `Scheduler` in
      `src/cli/autorun-scheduler.ts`.
- [x] 2.2 Extend `SchedulerDeps` with a required `maxFailures:
      number` field. Update every existing constructor call site
      (autorun entrypoint, tests) to pass it.

## 3. Failure counting

- [x] 3.1 In the post-run handler in `Scheduler.start()` (the
      `.then(...)` block that releases the in-flight slot), after
      `this.inFlight.delete(change)`, increment
      `failureCounts.get(change)` (default `0`) by `1` when:
      `result.status === "failed"` AND `result.reason !==
      "user_quit"`. Treat missing / unknown reasons as failures
      that count.
- [x] 3.2 In the error path (`.then(_, err => ...)`), increment
      the counter unconditionally — a thrown error is a brief-
      side failure (no `user_quit` synthesis on the throw path).
- [x] 3.3 The increment SHALL happen before the `onCompleted` /
      `onError` callbacks fire, so callbacks observe the
      post-increment count (relevant if the autorun entrypoint
      ever exposes the count to the TUI). The slot release order
      relative to the callbacks is unchanged.

## 4. Decide-time cap check

- [x] 4.1 In `Scheduler.decide()`, immediately before the
      existing `if (this.inFlight.size >= this.deps.maxConcurrent)`
      concurrency check, add the cap check:

      ```ts
      const failureCount = this.failureCounts.get(change) ?? 0;
      if (this.maxFailures > 0 && failureCount >= this.maxFailures) {
        return {
          action: "skip",
          reason: "failure-cap",
          brief,
          detail: `${failureCount}/${this.maxFailures}`,
        };
      }
      ```

- [x] 4.2 Confirm precedence: `in-flight`, `filtered`,
      `running-elsewhere`, `done`, `blocked`, `activity-succeeded`
      all short-circuit *before* `failure-cap`; `concurrency`
      runs *after* `failure-cap`. Update the existing precedence
      comment (if any) to reflect the new position.

## 5. SkipReason enum extension

- [x] 5.1 Add `"failure-cap"` to the `SkipReason` union in
      `src/cli/autorun-scheduler.ts`.
- [x] 5.2 Grep for consumers of `SkipReason` (e.g. autorun TUI
      brief-list renderer, log helpers, JSON serializer). Add a
      branch for the new value in any exhaustive switch.
      Verify TypeScript-strict catches the missing branches at
      compile time.

## 6. Logging

- [x] 6.1 Extend the raw-mode log renderer in `src/cli/autorun.ts`
      (the function that handles `kind: "skipped"`) to produce
      `failure cap reached (<count>/<max>); restart autorun to
      retry` for `reason === "failure-cap"`, using the `detail`
      field.
- [x] 6.2 Verify JSON-mode emission already serialises `reason`
      and `detail` as-is. If the JSON renderer has a hard-coded
      reason allowlist, extend it. The shape SHALL be
      `{"event":"skipped","ts":...,"change":"<c>","reason":"failure-cap","detail":"3/3"}`.

## 7. Tests

- [x] 7.1 Add `src/cli/autorun-scheduler.test.ts` cases:
      - Counter increments on a failed dispatch with a node-side
        reason (`node_failed`, `graph_drained`,
        `budget_exhausted`, `sentinel_failed`).
      - Counter does NOT increment when `result.reason ===
        "user_quit"`.
      - Counter increments when `result.reason` is undefined
        (unknown-reason default).
      - Brief is skipped with `reason: "failure-cap"` and
        `detail: "<n>/<n>"` after `maxFailures` consecutive
        failures.
      - `maxFailures: 0` disables the cap (no skip even after
        many failures).
      - `maxFailures: 5` allows 5 failures, then caps on the
        6th decide call.
      - Per-change isolation: a cap on change A does not affect
        change B.
      - Precedence: a capped brief that also has unsatisfied
        deps surfaces as `blocked`, not `failure-cap`.
      - Precedence: a capped brief that is also already
        `in-flight` surfaces as `in-flight`, not `failure-cap`.
      - Fresh `Scheduler` instance starts with an empty counter
        map (restart-to-reset).
- [x] 7.2 Add `src/cli/autorun.test.ts` (or the equivalent log-
      format test file) cases for the raw and JSON log-line
      shapes when `failure-cap` fires.
- [x] 7.3 Verify all existing autorun tests still pass after the
      `SchedulerDeps.maxFailures` field is added (default `0`
      in test fixtures keeps them on legacy behavior unless
      they opt in).

## 8. Docs

- [x] 8.1 Update `docs/concepts/Auto-Mode.md` with a "Failure
      cap" section covering: default `3`, the `--max-failures`
      override, the restart-to-reset gesture, which failure
      reasons count (`node_failed`, `graph_drained`,
      `budget_exhausted`, `sentinel_failed`,
      `missing_required_output`) and which do not (`user_quit`).
- [x] 8.2 Update `docs/CLI.md` autorun section: add
      `--max-failures <n>` to the options table, add a note in
      the description that the cap exists and how to reset
      (restart), and add `failure-cap` to any skip-reason
      enumeration in the doc.

## 9. Verify

- [x] 9.1 Run the full test suite. All pre-existing autorun
      tests pass; new tests pass.
- [x] 9.2 Run `minifac autorun --max-failures 1 --once` against a
      hand-rigged inputs/ tree with a deliberately failing brief
      and confirm the cap log line appears on the second poll
      (manual smoke; documented as part of the verify step but
      not part of automated CI).
- [x] 9.3 Run `openspec validate autorun-failure-backoff` clean.
