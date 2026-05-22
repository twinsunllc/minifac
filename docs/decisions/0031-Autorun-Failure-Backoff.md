---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0031: Autorun per-session failure cap

## Context

`minifac autorun`'s scheduler retries failed briefs
indefinitely. A brief whose `activity === "failed"` is
**not** a skip condition in
`src/cli/autorun-scheduler.ts:147-150` — only `running` and
`succeeded` skip the dispatch. The reasoning was "transient
failures deserve a retry without human intervention."

In practice this is too permissive. A brief with a real bug
(malformed frontmatter, factory that always fails verify, a
test the model can't make pass) will get hammered on every
poll cycle. The cost — wasted apply / verify work, runs.db
churn, model token spend — adds up fast on a long-running
autorun session.

This ADR adds a **per-session failure cap**: after N
consecutive failures of the same change within a single
autorun process, that change stops being scheduled until the
operator restarts autorun.

The choice of "restart to reset" matches minifac's existing
philosophy of leaning on operator intervention over
auto-recovery. It's also dead simple: no persistent
back-off state to maintain, no exponential timing, no file-
hash heuristics. Quit, restart, fresh slate.

## Decision

### Per-session counter, in-memory only

The scheduler maintains a `Map<changeName, failureCount>`
that:

- Increments by 1 each time a dispatched run for that change
  completes with `status: "failed"` during this autorun
  session
- Is consulted by `decide()` before dispatching: if
  `count >= maxFailures`, return
  `{ action: "skip", reason: "failure-cap" }`
- **Does not persist across autorun restarts.** A fresh
  process starts with an empty map.
- **Is not affected by pre-session run history.** A brief
  that failed 50 times yesterday still gets `maxFailures`
  attempts in today's session.

### Default cap and override

Default `--max-failures 3`. A new CLI flag on `autorun`
overrides:

```bash
minifac autorun --max-failures 5    # raise cap
minifac autorun --max-failures 1    # one strike
minifac autorun --max-failures 0    # disable (current behavior)
```

`0` is the explicit opt-out. The default `3` is a balance:
forgiving enough to absorb transient failures (rate limits,
flaky network, model nondeterminism on the boundary case),
strict enough to stop wasting cycles on persistent bugs.

### Skip reason in the existing enum

`SkipReason` gains a new value `failure-cap` joining the
existing `in-flight | filtered | done | blocked |
activity-running | activity-succeeded | concurrency` set.

The scheduler logs a clear message when a brief is skipped
for this reason:

```
[autorun] skipped node-outputs: failure cap reached (3/3); restart autorun to retry
```

Same shape in `--json` mode:

```json
{"kind":"skipped","change":"node-outputs","reason":"failure-cap","detail":"3/3"}
```

### Reset path: restart

If the operator wants to retry a capped brief, they:

1. Investigate why it failed (e.g., `minifac runs --change <name> --status failed`)
2. Fix the brief or the factory (or accept that this brief shouldn't run)
3. Stop autorun (`Ctrl-C` or `SIGTERM`)
4. Start it again

No special "reset cap" command. Restart is the reset.

## Consequences

- **Predictable cost ceiling per session.** A broken brief
  can spend at most `maxFailures` × (apply cost) before
  autorun gives up on it.
- **Operator gets a clear signal.** The skip-reason log
  makes "this brief is being skipped because it keeps
  failing" explicit. Compared to silent indefinite retry,
  this is much easier to diagnose.
- **No persistent state.** Restarts give fresh slates,
  which matches the "in-memory scheduler counter is the
  whole mechanism" philosophy. No new database tables, no
  on-disk state, no cleanup story.
- **The `--ready` CLI filter remains stateless and
  unaffected.** It shows what *would* be ready under fresh
  conditions; the in-session cap is a separate runtime
  concern.
- **One new CLI flag, one new skip reason.** Tiny surface
  area; easy to remove or evolve later if a more
  sophisticated approach (persistent back-off, per-brief
  override) earns its way in.

## Alternatives considered

- **No cap (current behavior).** Rejected — the cost of
  indefinite retry on a broken brief is real, and the
  operator pays it without any visible signal until they
  notice runs.db filling up with failures.
- **Persistent failure tracking in `runs.db`.** Rejected
  for v1 — adds a schema migration, a cleanup story, and
  the question of "what counts as a 'fresh start'." The
  in-memory per-session model is simpler and sufficient.
- **Exponential back-off in time** (wait 5min, then 10,
  then 20, ...). Rejected — adds a clock-management
  mechanism for a problem the simpler cap handles. Also
  doesn't address the "obviously broken brief" case at
  all; eventually it just retries less often. The cap is
  the right shape.
- **Reset on brief file modification (hash the file
  content).** Considered. Probably the right v2 if anyone
  asks. Rejected for v1 because:
  - The current model is simpler (just an in-memory map)
  - Detecting file changes from inside autorun introduces
    a small race
  - Restart-to-reset is a workable manual gesture
- **Per-brief override** (e.g., `max_failures: 5` in brief
  frontmatter). Deferred — global cap is fine to start.
  Add per-brief override when someone has a concrete need.
- **Skip the dispatch silently** without logging. Rejected
  — operator visibility is the point. The skip reason
  must be loud.

## Open questions

- Should there be a `minifac autorun --status` or
  `minifac briefs --autorun-capped` command for inspecting
  the cap state of a running autorun process? Probably
  not for v1 — the log line is sufficient; the operator
  who notices a brief being skipped can check `runs` for
  the recent failures.
- Whether to count a `user_quit` failure (autorun was
  killed mid-run) toward the cap. Probably no — that's
  not a brief-side failure. Leaning to scope this to
  `node_failed`, `graph_drained`, `budget_exhausted`,
  `sentinel_failed`, `missing_required_output`. The brief
  spells this out.

## Related

- [[0015-Brief-Deps-and-State]] — the two-axis state model
  the scheduler reads; this ADR layers a runtime cap on top
- [[0016-Auto-Mode]] — the autorun mechanism this ADR
  hardens
- [[Open-Questions]] — the "autorun keeps retrying broken
  briefs" question was deferred there; this ADR resolves it
