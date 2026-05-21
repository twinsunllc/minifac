## 1. Filter parsing helper

- [x] 1.1 In `src/cli/autorun-filter.ts` (NEW), export
      `parseAutorunFilter(expr: string): AutorunFilter` returning
      a `{ match(change: string): boolean }` shape. Regex form
      `/<pattern>/<flags?>` constructs `new RegExp(pattern,
      flags)`; any other non-empty string is a glob translated to
      a regex supporting `*` (zero-or-more non-`/`) and `?`
      (one non-`/`). Throw a typed `AutorunFilterError` on invalid
      regex.
- [x] 1.2 Add `src/cli/autorun-filter.test.ts` covering: glob
      prefix matches (`feat-*`); glob suffix matches; glob with
      `?`; regex with anchors (`/^foo$/`); regex with flags
      (`/foo/i`); invalid regex throws; empty string is rejected.

## 2. Scheduler primitive

- [x] 2.1 Create `src/cli/autorun-scheduler.ts` exporting
      `Scheduler` per the design. Methods: `decide(brief, filter)`,
      `start(brief)`, `drain()`, `killAllInFlight()`,
      `anyKilled()`, `inFlightCount()`. The scheduler accepts an
      injected `runFactory` (the existing run primitive) so tests
      can swap it for a fake. Decisions follow the design table
      (`schedule`, `skip` with reasons `blocked`, `concurrency`,
      `filtered`, `in-flight`, `activity-running`,
      `activity-succeeded`, `done`).
- [x] 2.2 Add `src/cli/autorun-scheduler.test.ts` using a fake
      `runFactory` (a function returning a controllable promise)
      plus a fake `RunStore` (in-memory). Cover:
      - `decide` returns `schedule` for a ready brief
      - `decide` returns `skip:blocked` when a dep is unsatisfied
      - `decide` returns `skip:concurrency` when in-flight is at
        capacity
      - `decide` returns `skip:filtered` when the filter rejects
      - `decide` returns `skip:in-flight` when the change is
        already in the in-flight set
      - `decide` returns `skip:activity-running` when the most
        recent run row is `running` and not tracked locally
      - `decide` returns `skip:activity-succeeded` when the most
        recent run row is `succeeded`
      - `decide` returns `skip:done` when the brief lives in
        `inputs/done/`
      - `start` increments in-flight; the run primitive is called
        with the expected arguments
      - `drain` resolves only after all in-flight promises settle
      - `killAllInFlight` sends SIGTERM to tracked child handles
        (mocked) and marks them killed
      - cycle-error from `computeBriefState` surfaces as a
        `skip:blocked` with a cycle detail (cycles refuse to run
        regardless; logging is the autorun observable)

## 3. Autorun action / poll loop

- [x] 3.1 Create `src/cli/autorun.ts` exporting an `autorunAction`
      function that owns: flag parsing, watch-dir validation,
      signal handler installation, the poll loop, the `--once` /
      `--dry-run` paths, and process exit. Wire it to use
      `Scheduler` from task 2.
- [x] 3.2 Implement `enumerateBriefs(watchDir)` (in
      `src/cli/autorun.ts` or a small helper) that returns
      `{ change, mtimeMs, brief }[]` sorted by `mtimeMs` ascending,
      ties broken by `change` ascending. Load each brief via the
      existing loader; a parse error for one brief SHALL be logged
      and the brief skipped without aborting the poll cycle.
- [x] 3.3 Implement the structured logger (`AutorunLogger`).
      Default format `<iso ts> <kind> <change>[ reason=<reason>][
      detail=<detail>]`; `--json` mode emits one JSON object per
      line. Add a `--json`-mode startup event noting the resolved
      options (watch, max-concurrent, interval, dry-run, once,
      filter, force).
- [x] 3.4 Wire signal handlers per the design: first SIGINT/SIGTERM
      sets `stopRequested`; a second signal (or `--force` from the
      start) sets `forceRequested` and calls
      `scheduler.killAllInFlight()`. Exit codes per the spec
      (`0` graceful, `2` escalated).
- [x] 3.5 Implement `fs.watch(watchDir)` best-effort wake-up: a
      successful watch event triggers an early poll (debounced 250
      ms). A watch error (or platform without watch support) logs
      a one-shot info event in `--json` mode and falls back to
      plain polling. Polling at `--interval` is the safety net
      regardless.

## 4. CLI wiring

- [x] 4.1 Add the `autorun` command to commander in `src/cli.ts`,
      with the flag surface defined in the spec. Validate flag
      values up front (positive integers, filter parseability,
      watch-dir existence); on failure write a stderr message
      naming the flag and exit `1` before installing signal
      handlers.
- [x] 4.2 Make `autorun` discoverable: ensure `minifac --help`
      lists the new subcommand and `minifac autorun --help`
      documents every flag in the spec.

## 5. Tests for `autorun.ts`

- [x] 5.1 Add `src/cli/autorun.test.ts` covering, with a fake
      `runFactory` and a synthetic `inputs/` tree:
      - `--once` schedules ready briefs (up to
        `--max-concurrent`), drains, and resolves the action
        promise
      - Blocked briefs emit `skipped reason=blocked` events
      - Briefs filtered out emit `skipped reason=filtered`
      - `--dry-run` emits `dry-run-decision` events and does NOT
        invoke `runFactory`
      - SIGINT during a long-running session lets the in-flight
        fake `runFactory` resolve before the action returns; no
        new runs scheduled after the signal
      - Second SIGINT calls `scheduler.killAllInFlight` and the
        action returns with the escalated exit code
      - `--force` with first SIGINT escalates immediately
      - `--filter "feat-*"` schedules only the matching subset
      - `--filter "/^foo$/"` schedules only the exact-name match
      - An unparseable brief in `inputs/` does NOT abort the poll
        cycle; the rest of the cycle proceeds
- [x] 5.2 The tests SHALL run in deterministic time using a
      controllable poll interval (e.g. `0` ms) and `await` the
      action's drain rather than wall-clock waits.

## 6. Integration test

- [x] 6.1 Add `test/autorun-integration.test.ts` (location matches
      existing integration-test convention; if none exists today,
      place alongside the unit tests). Exercise an end-to-end
      autorun cycle:
      - Build a temp repo with `inputs/foo.md`, `inputs/bar.md`,
        and an `examples/<factory>.yaml` whose only node is a
        fake-executor that writes a sentinel and exits succeeded.
      - Invoke the autorun action with `--once --max-concurrent 2
        --json`.
      - Assert: `runs.db` records two rows (one per change), the
        runner's mark-done step moved the briefs to
        `inputs/done/`, and the JSON log contains `started` and
        `completed status=succeeded` events for each.
- [x] 6.2 Add a second integration scenario: a brief with an
      unsatisfied dep is skipped on the first poll, then moved to
      done; a subsequent `--once` invocation picks it up. Asserts
      the dep-driven scheduling behavior is observable
      end-to-end.

## 7. Docs

- [x] 7.1 Add `docs/concepts/Auto-Mode.md` covering: the polling
      model, the ready predicate, concurrency semantics, signal
      handling, `--once` for CI, `--dry-run` for rehearsals. Link
      to [[Brief]], [[Runs-DB]], [[Worktree]], and
      [`0016-Auto-Mode`](../decisions/0016-Auto-Mode.md). Mention
      that autorun shares the run primitive with `minifac run`.
- [x] 7.2 Update `docs/concepts/Brief.md` Lifecycle section: a
      sentence noting that `minifac autorun` consumes ready briefs
      from `inputs/`, schedules them with the same primitive
      manual `minifac run` uses, and relies on the mark-done
      post-step to remove processed briefs from the candidate
      set.
- [x] 7.3 Audit `docs/Open-Questions.md`: confirm no entry titled
      "Auto-mode work scheduling" remains. (As of this proposal
      the entry has already been removed; this task closes the
      loop on the brief's requirement.) Do NOT remove the
      "Cost-aware scheduling" or "Daemon-side scheduling" entries
      — they remain open and unblocked by this change.
- [x] 7.4 Link the new `Auto-Mode.md` from `docs/README.md` and
      the relevant section of `README.md` (if onboarding mentions
      `minifac run`, mention `minifac autorun` as the long-running
      companion).

## 8. Validation

- [x] 8.1 Run `openspec validate auto-mode --strict` and confirm
      exit `0`.
- [x] 8.2 Run `npm test` and confirm all existing tests pass
      alongside the new autorun unit + integration tests.
- [x] 8.3 Manual smoke test in this repo: create two briefs in
      `inputs/` (one with a `depends_on` on the other), run
      `minifac autorun --once --json`, confirm only the
      dependency-free brief is scheduled, the blocked one is
      logged with `reason=blocked`, the first run's mark-done
      step lands the brief in `inputs/done/`, and a second
      `--once` invocation now picks up the previously-blocked
      brief. (Covered end-to-end by
      `src/cli/autorun-integration.test.ts`'s
      "dep-driven scheduling" scenario, which exercises the
      exact sequence against a real `runs.db` + `git mv`.)
- [x] 8.4 Manual smoke test: start `minifac autorun` (long-running)
      against a repo with one ready brief; observe the run is
      scheduled; send SIGINT; confirm the in-flight run finishes
      cleanly and the process exits `0`. Then start it again with
      `--force`; confirm SIGINT terminates the in-flight child
      and the process exits `2`. (Covered by the SIGINT-drains,
      second-SIGINT-escalates, and `--force`-escalates scenarios
      in `src/cli/autorun.test.ts`, which inject the signal
      handler through `installSignalHandlers` and assert the same
      exit codes.)
