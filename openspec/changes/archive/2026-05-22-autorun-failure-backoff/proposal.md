## Why

`minifac autorun`'s scheduler retries failed briefs indefinitely.
`activity === "failed"` is not a skip condition in
`src/cli/autorun-scheduler.ts` — only `running` and `succeeded`
short-circuit dispatch. A brief with a real bug (malformed
frontmatter, an always-failing verify gate, a test the model
can't fix) gets dispatched on every poll cycle, burning apply/
verify work, runs.db rows, and model tokens on a known-broken
loop until the operator notices.

Decision [`0031-Autorun-Failure-Backoff`](../../../docs/decisions/0031-Autorun-Failure-Backoff.md)
pins the shape: a **per-session in-memory failure cap**.
After N consecutive failures of the same change within a single
autorun process, that change stops being scheduled until the
operator restarts autorun. No persistent state, no exponential
back-off, no file-hash heuristics — quit, restart, fresh slate.

## What Changes

- **NEW** `--max-failures <n>` flag on `minifac autorun`.
  Default `3`. `0` disables the cap (current indefinite-retry
  behavior).
- **NEW** in-memory `Map<change, failureCount>` on the scheduler.
  Increments when a dispatched run completes with
  `status: "failed"` and a non-`user_quit` reason. Consulted by
  `decide()` before the concurrency check.
- **NEW** `SkipReason` value `failure-cap`. Joins the existing
  `blocked | concurrency | filtered | in-flight |
  running-elsewhere | activity-succeeded | done` set.
- **NEW** structured-logging case for the new skip reason in both
  raw and JSON modes, naming the count and the recovery gesture
  ("restart autorun to retry").
- **MODIFIED** `auto-mode` capability spec — adds the failure-cap
  requirement and scenarios, and adds `failure-cap` to the
  `SkipReason` enum requirement.
- **MODIFIED** `run-cli` capability spec — adds the
  `--max-failures` flag to the `minifac autorun` subcommand
  requirement.
- **MODIFIED** `docs/concepts/Auto-Mode.md` — documents the cap,
  default, override flag, restart-to-reset gesture, and which
  failure reasons count.
- **MODIFIED** `docs/CLI.md` — adds `--max-failures <n>` to the
  autorun options table and mentions `failure-cap` in the
  skip-reason discussion.

Explicitly **out of scope** (deferred):

- Persistent failure state across autorun restarts.
- Exponential time-based back-off.
- Reset on brief file modification (file hash detection).
- Per-brief `max_failures` frontmatter override.
- A "reset cap for change X" CLI command.
- Counting `running` (timed-out) runs toward the cap.

## Impact

- **Affected specs**:
  - `auto-mode` (MODIFIED): adds a new requirement for the
    per-session failure cap, modifies the `SkipReason` enum
    requirement, modifies the structured-logging requirement
    to cover the new reason.
  - `run-cli` (MODIFIED): adds the `--max-failures` flag to the
    `minifac autorun` subcommand requirement.

- **Affected code**:
  - `src/cli.ts`: parse `--max-failures <n>`, validate
    non-negative integer, pass to the autorun entrypoint.
  - `src/cli/autorun.ts`: thread `maxFailures` into the
    scheduler; add the log case for the new skip reason in
    raw and JSON renderers.
  - `src/cli/autorun-scheduler.ts`: add `failureCounts` map,
    `maxFailures` dep, the cap check in `decide()`, the
    increment in the post-run handler (after the existing
    in-flight slot release), and `failure-cap` to the
    `SkipReason` enum.
  - `src/cli/autorun-scheduler.test.ts` (and
    `src/cli/autorun.test.ts` if log-format coverage lives
    there): new cases per the acceptance criteria.

- **Affected docs**:
  - `docs/concepts/Auto-Mode.md`: new "Failure cap" section.
  - `docs/CLI.md`: updated autorun options table and
    skip-reason discussion.
