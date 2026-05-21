## Why

Every dogfood so far has been driven by an explicit `minifac run
<brief>` invocation. With computed brief state and `depends_on`
landing in [[0015-Brief-Deps-and-State]], the next step is a
long-running minifac process that polls the backlog and runs ready
[[Brief]]s without manual ceremony — the "build farm" framing from
[`0016-Auto-Mode`](../../../docs/decisions/0016-Auto-Mode.md).

The shape is pinned in 0016: a new `minifac autorun` CLI that polls
`inputs/`, schedules briefs whose state is `pending` with deps
satisfied, respects a `--max-concurrent` cap, and exits gracefully on
SIGINT. Concurrency is safe today because [[Worktree]]s isolate runs
and [[Runs-DB]] handles concurrent writers via SQLite WAL. The
per-change-name lockfile (per [[0009-Worktree-Default]]) already
prevents same-change collisions.

This change implements that decision. It does not introduce
priorities, cost caps, daemon coupling, or OS-level triggers — those
are explicit non-goals in 0016 and remain in [[Open-Questions]].

## What Changes

- **NEW** `minifac autorun` subcommand that polls a configured
  inputs directory, computes each brief's state via
  `computeBriefState` (from [[0015-Brief-Deps-and-State]]), and
  schedules briefs whose `doneness === "active"`, every dep
  `doneness === "done"`, and `activity ∈ {none, failed}`.
- **NEW** scheduling primitive: autorun reuses the existing
  `runFactory(...)` and worktree-creation machinery so each autorun
  run is indistinguishable from a manual `minifac run` invocation
  (same store, same lockfile contract, same cleanup semantics).
- **NEW** flags `--watch <dir>`, `--max-concurrent <n>`, `--interval
  <ms>`, `--once`, `--filter <expr>`, `--dry-run`, `--json`, and
  `--force` (signal-handling variant).
- **NEW** selection order: oldest brief file mtime first, with a
  stable lexicographic tiebreak on `change`. Filesystem listing
  order is not assumed.
- **NEW** structured logging for scheduling events (`started`,
  `skipped:blocked`, `skipped:concurrency`, `skipped:filtered`,
  `skipped:in-flight`, `completed`, `failed`). Default emits a short
  human-readable line; `--json` emits one JSON object per line.
- **NEW** graceful shutdown: SIGINT/SIGTERM stop scheduling new runs
  and wait for in-flight runs to settle (exit `0`). A second SIGINT
  (or SIGTERM with `--force` from the start) interrupts in-flight
  runs by killing their child executor processes (exit non-zero).
- **NEW** `--once` mode runs a single poll cycle, waits for the
  scheduled runs to finish, and exits zero — useful for CI.
- **NEW** `--dry-run` mode runs a single poll cycle, prints which
  briefs would be scheduled (and which would be skipped, with
  reason), invokes no runs, and exits zero.
- **NEW** capability `auto-mode` covering the autorun loop,
  scheduling policy, concurrency semantics, signal handling, and
  CLI flag surface.
- **MODIFIED** `run-cli` capability adds an `autorun` subcommand
  requirement alongside the existing `run`, `runs`, `briefs`, etc.

## Impact

- **Affected specs**:
  - NEW capability `auto-mode` with requirements for: the poll
    loop, the ready predicate, selection order, concurrency,
    structured logging, signal handling, `--once`, `--dry-run`,
    and `--filter`.
  - `run-cli` (MODIFIED): adds a `minifac autorun` subcommand
    requirement.

- **Affected code**:
  - `src/cli/autorun.ts` (NEW): the `autorun` action — flag parsing,
    poll loop, signal handling, structured logging, dry-run output.
  - `src/cli/autorun-scheduler.ts` (NEW): the in-flight tracker and
    scheduling primitive (separated for testability with a fake
    `runFactory`).
  - `src/cli.ts`: wire the `autorun` subcommand into commander.
  - `src/cli/autorun.test.ts` (NEW): unit tests with a fake
    `RunStore` + synthetic inputs/ directory.
  - `src/cli/autorun-scheduler.test.ts` (NEW): in-flight tracker
    unit tests.
  - `test/autorun-integration.test.ts` (NEW): integration test
    exercising a small inputs/ tree end-to-end with a fake
    executor (no real Claude calls).

- **Affected docs**:
  - `docs/concepts/Auto-Mode.md` (NEW): polling model, concurrency,
    signal handling, comparison with one-shot `minifac run`.
  - `docs/concepts/Brief.md`: lifecycle section mentions autorun as
    a consumer of `ready` briefs.
  - `docs/Open-Questions.md`: confirm no "Auto-mode work
    scheduling" entry remains; leave related "Cost-aware
    scheduling" and "Daemon-side scheduling" entries intact
    (still open).

- **Out of scope** (deferred — see 0016):
  - Daemon-integrated autorun (`minifac serve --autorun`).
  - Priority / scoring / topological-sort-with-weights scheduling.
  - OS-level triggers (cron, webhook).
  - UI surfacing of autorun state (Studio's concern).
  - Cost caps (`--max-spend-per-hour`). `--max-concurrent` is the
    only safety knob in v0.

- **No new runtime dependencies.** Polling uses `setTimeout`;
  filesystem watching uses Node's built-in `fs.watch` (best-effort,
  polling is the safety net); glob matching uses the brief's filter
  string interpreted as a glob or `/.../` regex literal (a small
  helper, no new package).
