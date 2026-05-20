---
status: accepted
date: 2026-05-20
supersedes: []
superseded-by: null
tags: [decision]
---

# 0016: Auto-mode — long-running minifac picks up ready work

## Context

Every dogfood so far has been driven by an explicit `minifac run
<brief>` invocation. With [[Brief]] dependencies and computed state
landing (see [[0015-Brief-Deps-and-State]]), the natural next step is
a long-running minifac process that polls the backlog and runs ready
briefs without manual ceremony. This is the "build farm" framing —
factories pick up work as it becomes available.

## Decision

**New CLI command `minifac autorun`**. Long-running by default;
polls `inputs/` for briefs whose computed state is `pending` with all
`depends_on` satisfied, schedules them, repeats.

```
minifac autorun [options]
  --watch <dir>           inputs dir to watch (default: ./inputs)
  --max-concurrent <n>    parallel run cap (default: 1)
  --interval <ms>         poll cadence (default: 10000)
  --once                  run all currently-ready briefs, then exit
  --filter <expr>         skip briefs whose `change` doesn't match (glob or regex)
  --dry-run               print what would be scheduled; don't run
```

**Scheduling policy** (v0): oldest-ready-first by brief file mtime,
ties broken by `change` name lexicographically. A `priority` field on
briefs is filed as a future enhancement.

**Concurrency** is governed by `--max-concurrent`. Multiple briefs
schedule in parallel; each gets its own [[Worktree]] per
[[0009-Worktree-Default]]. The per-change-name lockfile contract
already prevents collisions.

**Polling** is the v0 mechanism. `fs.watch` for inputs/ changes is a
nice-to-have but unreliable cross-platform; polling at a configurable
interval is the safety net. If `fs.watch` is available and works,
treat it as a wake-up signal that triggers an immediate poll;
otherwise the timer suffices.

**Graceful shutdown.** SIGINT/SIGTERM stop scheduling new runs but
allow in-flight runs to finish (with a `--force` flag that interrupts
them by killing the child executor processes). Autorun exits when all
in-flight runs settle.

**Logging.** Autorun emits a structured log line whenever it
schedules a run, skips a brief (with reason), or completes a run.
Both human-readable text and a `--json` mode for piping into other
tools.

**No daemon coupling.** `minifac autorun` is a standalone process. If
the daemon happens to be running, autorun-scheduled runs surface in
the viewer like any other (same [[Runs-DB]] backing). The daemon does
NOT run autorun internally for v0 — that's a future ergonomic
improvement.

## Consequences

- The build-farm vision is real: drop briefs in `inputs/`, let
  autorun chew through them
- API spend can balloon without supervision; `--max-concurrent` is
  the user's primary safety knob, `--dry-run` is the rehearsal
- Concurrent runs share the [[Runs-DB]] via SQLite WAL — no extra
  coordination needed
- The brief-state derivation from [[0015-Brief-Deps-and-State]] is
  hot-path: autorun calls it every poll cycle for every brief in the
  watched dir. Performance budget: poll must complete in <100ms for
  a backlog of ~200 briefs. If we hit that ceiling, the response is
  to cache computed state per-poll (recompute only when runs.db or
  the brief file changes), not to add stored state.
- Cycles in the dep graph (rejected by [[0015-Brief-Deps-and-State]])
  cannot manifest at runtime — they'd be caught at brief load.
- Failure containment: a failed brief blocks its descendants but
  doesn't crash autorun. The loop continues processing unrelated
  branches.

## Alternatives considered

- **Make this a daemon mode** (e.g., `minifac serve --autorun`).
  Rejected for v0 — coupling autorun to the daemon means you can't
  run autorun without the viewer process. Better to ship as a
  separate command; daemon integration becomes a thin wrapper later
  if it earns the integration.
- **More complex selection policy** (priority, scoring, lottery,
  topological sort with weights). Rejected — oldest-ready-first
  covers the common case; richer policies earn their way in.
- **Push notifications via the OS** (`inotify`, `fs.watch`, etc.)
  instead of polling. Rejected as the sole mechanism (cross-platform
  fragility); kept as an optional wake-up signal.
- **No concurrency** (always one run at a time). Rejected — once
  worktrees are isolated and runs.db is concurrent-safe, leaving
  concurrency on the table is wasted.

## Related

- [[Brief]] — what autorun consumes
- [[Worktree]] — per-run isolation makes concurrency safe
- [[Runs-DB]] — autorun's state source
- [[0009-Worktree-Default]] — lockfile contract prevents same-change
  collisions
- [[0015-Brief-Deps-and-State]] — `ready` predicate
- [[Open-Questions]] — removes the "Auto-mode work scheduling" entry
