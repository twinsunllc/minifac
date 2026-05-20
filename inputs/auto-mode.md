---
change: auto-mode
factory: sdd
base_branch: main
depends_on: [brief-deps-and-state]
---

## Background

With briefs gaining computed state + dependencies (see
`docs/decisions/0015-Brief-Deps-and-State.md`), the natural next step
is a long-running minifac process that polls the backlog and runs
ready briefs without manual ceremony. The decision is captured at
`docs/decisions/0016-Auto-Mode.md`; read it first.

This brief depends on `brief-deps-and-state` landing first
(`depends_on` frontmatter, enforced by the runner once
`brief-deps-and-state` itself ships).

## What to do

Implement what 0016 describes. Concretely:

### 1. New CLI command `minifac autorun`

- `src/cli/autorun.ts` implementing the subcommand:

      minifac autorun [options]
        --watch <dir>           inputs dir (default: ./inputs)
        --max-concurrent <n>    parallel run cap (default: 1)
        --interval <ms>         poll cadence (default: 10000)
        --once                  run currently-ready briefs, then exit
        --filter <expr>         glob or regex on `change`
        --dry-run               print what would run; don't run
        --json                  structured log lines

- Long-running by default. SIGINT / SIGTERM stop scheduling new runs;
  in-flight runs are allowed to finish. `--force` on the second
  signal interrupts in-flight runs by killing their child executor
  processes.

### 2. Polling loop

- Every `--interval` ms, list briefs in `--watch`, compute each
  brief's state via the API from
  [[0015-Brief-Deps-and-State]]'s `computeBriefState`.
- Schedule briefs whose state is `pending` AND every `depends_on` is
  `succeeded`, up to `--max-concurrent - <in-flight count>` per poll.
- Selection order: oldest brief file mtime first; tiebreak by
  `change` lexicographic. Implement as a stable sort; do not assume
  filesystem listing order.
- `fs.watch` on `--watch` (if available and not error-prone on the
  current platform) wakes the loop early on any change. Polling
  remains the safety net.

### 3. Scheduling primitive

- Reuse the existing `runFactory(...)` and worktree-creation
  machinery from `worktree-mode`. Autorun spawns runs in the same
  way `minifac run` does — same store, same lockfile contract, same
  cleanup-on-exit semantics.
- Concurrent runs proceed in separate worktrees. The per-change-name
  lockfile prevents collisions. The [[Runs-DB]] handles concurrent
  writers via SQLite WAL.

### 4. Logging

- For each scheduling event (started, skipped-due-to-blocked,
  skipped-due-to-concurrency, completed, failed), emit a structured
  log line. `--json` mode emits one JSON object per line; default
  emits a short human-readable line.
- Log includes timestamp, change name, action, and (for skips) the
  reason.

### 5. Graceful shutdown

- SIGINT / SIGTERM: stop polling, wait for in-flight runs to settle,
  exit zero.
- A second SIGINT (or SIGTERM with `--force` from the start): kill
  in-flight child processes; exit non-zero.

### 6. `--once` mode

- One full poll cycle: list all briefs, schedule everything ready (up
  to `--max-concurrent`), wait for those runs to finish, exit zero.
- Useful for CI integration where you want autorun-like behavior in
  a single invocation.

### 7. `--dry-run`

- One poll cycle, but instead of scheduling, print which briefs
  WOULD be scheduled (and which would be skipped, and why). No runs
  start. Useful before committing to a long autorun session.

### 8. Tests

- Unit tests with a fake `RunStore` + synthetic inputs/ directory:
  - Scheduling respects `--max-concurrent`
  - Blocked briefs aren't scheduled
  - Skipped briefs emit the right log entries
  - SIGINT lets in-flight runs settle (use a fake long-running
    `runFactory`)
  - `--once` exits after currently-ready briefs finish
  - `--dry-run` doesn't invoke `runFactory`
  - `--filter` matches glob and regex syntaxes
- Integration test that exercises a small inputs/ tree end-to-end
  with a fake executor (no real Claude calls).

### 9. Specs

- NEW capability `auto-mode` covering the autorun loop, the
  scheduling policy, concurrency semantics, signal handling, and
  the CLI flags. Scenarios for ready selection, blocked refusal,
  `--once`, `--dry-run`, SIGINT handling.
- `run-cli`: MODIFIED requirement to add the `autorun` subcommand.

### 10. Documentation

- Update `docs/concepts/Brief.md` Lifecycle section to mention
  autorun briefly.
- Add `docs/concepts/Auto-Mode.md` (or fold into Brief / Runner) —
  your judgment — covering the polling model, concurrency, signal
  handling.
- Update `docs/Open-Questions.md`: remove the "Auto-mode work
  scheduling" entry.

## Out of scope

- **Daemon-integrated autorun** (e.g., `minifac serve --autorun`).
  Future ergonomic improvement.
- **Priority / scoring / topo-sort-with-weights scheduling.**
  Oldest-ready-first is enough for v0.
- **OS-level scheduling** (cron-style triggers, webhook triggers).
  Filed under `trigger-mechanisms` in [[Open-Questions]].
- **UI for autorun.** Studio's concern, not this change.
- **Cost caps.** `--max-concurrent` is the only safety knob in v0.
  A `--max-spend-per-hour` is a future enhancement once we have
  good cost telemetry.

## Acceptance criteria

- `minifac autorun --watch inputs --max-concurrent 2 --once`
  schedules ready briefs (up to 2 concurrent), waits, exits zero
- A `pending` brief with an unsatisfied dep is logged as skipped
  with the reason; another poll cycle reschedules it if the dep
  becomes `succeeded`
- SIGINT during a long autorun session stops scheduling but lets
  in-flight runs finish
- `--dry-run` prints scheduling decisions without invoking any runs
- Concurrent runs against different change names work; against the
  same change name are prevented by the lockfile
- `docs/Open-Questions.md` no longer has the "Auto-mode work
  scheduling" entry
- All existing tests still pass; new tests cover the autorun scenarios
