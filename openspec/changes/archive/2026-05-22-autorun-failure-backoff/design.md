## Context

Decision [`0031-Autorun-Failure-Backoff`](../../../docs/decisions/0031-Autorun-Failure-Backoff.md)
pins what we're building. This document pins how it lands inside
the current codebase.

Current state at the time of this proposal:

- `src/cli/autorun-scheduler.ts` exposes a `Scheduler` class with
  a `decide(brief, filter)` method that returns either
  `{ action: "schedule", brief }` or
  `{ action: "skip", reason: SkipReason, brief, detail? }`. The
  existing `SkipReason` enum is `blocked | concurrency | filtered
  | in-flight | running-elsewhere | activity-succeeded | done`.
  (Note: `activity-running` is reserved per the `auto-mode`
  capability and not currently used.)
- The scheduler's `start(brief)` method dispatches the run via
  the injected `runFactory`, registers an in-flight entry, and
  wires `promise.then(...)` to release the slot and invoke
  `onCompleted` / `onError`. There is **no** post-run hook
  upstream of the slot release where a failure-count increment
  could be missed; the existing `.then` handler is the natural
  place to bump the counter.
- `src/cli/autorun.ts` owns flag parsing (via commander wiring in
  `src/cli.ts`), the poll loop, the structured logger that turns
  `AutorunEvent`s into raw or JSON lines, and the signal-handling
  contract. Adding a new flag and a new log case is a localized
  change.
- `RunFactoryResult` includes an optional `reason?: string` field.
  The run primitive already populates this with a categorical
  string for known terminal failures (e.g. `node_failed`,
  `graph_drained`, `budget_exhausted`, `sentinel_failed`,
  `user_quit`). Whether the `missing_required_output` reason ever
  populates depends on [[0027-Node-Outputs]] landing; the cap
  logic should accept it once it does, but does not need to wait
  on it.

Constraints from `CLAUDE.md`:

- No premature subsystems. The failure counter is a `Map` on the
  scheduler, not a new module or class.
- No anthropomorphic metaphors. Naming: `failureCounts`,
  `maxFailures`, `failure-cap`. Not "punishment," "strikes," etc.
- TypeScript strict mode; tests next to code.
- No new runtime dependencies.

## Goals / Non-Goals

**Goals:**

- A bounded per-session failure budget per change.
- A clear log line when the cap fires, naming the count and the
  recovery gesture.
- An off-switch (`--max-failures 0`) that preserves the legacy
  indefinite-retry behavior for operators who prefer it.
- Restart-to-reset: a fresh autorun process starts with an empty
  counter map. No persistent state.

**Non-Goals:**

- Persistent failure tracking in `runs.db`.
- Exponential time-based back-off.
- File-hash detection that resets the cap when a brief is edited.
- Per-brief `max_failures` frontmatter override.
- A CLI command to inspect or reset the in-memory counter state
  of a running autorun process.
- Counting `running` (orphaned) rows toward the cap. The
  existing orphan-reconciliation path turns those into `failed`
  rows with `reason: "orphaned"` — that's a future call whether
  to count, but for v1 the cap counts only **dispatched** runs
  that completed `failed`, so orphan reconciliation does not
  feed the counter.

## Decisions

### Storage: a `Map<string, number>` on the `Scheduler`

```ts
private readonly failureCounts: Map<string, number> = new Map();
private readonly maxFailures: number;
```

Constructor reads `maxFailures` from `SchedulerDeps`. The autorun
entrypoint (`src/cli/autorun.ts`) passes the resolved CLI value.

A `Map` keyed by `change` (the brief slug) is the simplest fit.
No bounded LRU is needed — the cardinality is bounded by the
number of distinct briefs the operator ever cycles through in
one autorun session, which is small.

### Increment point: the existing `.then(...)` in `start()`

The post-run handler in `Scheduler.start()` is the only place a
dispatched run's terminal status flows through. After the slot
release (`this.inFlight.delete(change)`) and before / alongside
the `onCompleted` callback, increment the counter when:

- `result.status === "failed"`, AND
- `result.reason !== "user_quit"` (the autorun process was
  killed; the brief itself didn't fail).

Reason categorization for the cap:

- **Counts toward cap**: `node_failed`, `graph_drained`,
  `budget_exhausted`, `sentinel_failed`,
  `missing_required_output` (once [[0027-Node-Outputs]] ships).
- **Does not count**: `user_quit`.
- **Unknown / missing reason**: counts (safer default —
  unfamiliar categorical strings get treated as a real failure
  rather than silently exempted).

The error path (`.then(_, err => ...)`) treats throws as failures
too: the `onError` callback fires, and the wrapper synthesizes a
`status: "failed"` for `onCompleted`. The counter increment
happens here as well — a thrown error is a real brief-side
failure unless we have positive evidence it was a process-kill,
and the wrapper never gets a `user_quit` reason on the throw
path. Increment.

### Decide-time check, gated by `maxFailures > 0`

In `decide()`, immediately before the existing
`if (this.inFlight.size >= maxConcurrent)` concurrency check, add:

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

The gate is `maxFailures > 0` so that `--max-failures 0` cleanly
disables the feature. The check sits *after* `in-flight`,
`filtered`, `blocked`, `done`, and `activity-succeeded` so those
preconditions short-circuit first (a brief that's already done
or filtered out shouldn't surface as "failure-cap"). It sits
*before* the concurrency check so a capped brief doesn't
displace concurrency reasoning.

### `SkipReason` enum extension

Add `"failure-cap"` to the existing union in
`src/cli/autorun-scheduler.ts`. The logger in `src/cli/autorun.ts`
matches on this value to render the human-readable line and
include the `reason` field in JSON output. No other consumers of
`SkipReason` need to change — but a quick grep of the codebase
catches any switch/case that exhaustively destructures the union
(e.g. autorun TUI). The spec delta requires existing consumers
to handle the new value gracefully.

### Logging shapes

**Raw mode:**

```
<iso-timestamp> skipped <change>: failure cap reached (3/3); restart autorun to retry
```

The "; restart autorun to retry" suffix is intentional — the
operator who sees this message in tail mode needs to know the
gesture immediately, not look it up in docs.

**JSON mode:**

```json
{"event":"skipped","ts":"...","change":"<change>","reason":"failure-cap","detail":"3/3"}
```

The `detail` field matches the format used by other skip-reason
events (e.g. `blocked` carries a dep-name detail).

### CLI flag

```ts
.option(
  "--max-failures <n>",
  "Per-session failure cap per change; 0 disables",
  "3",
)
```

Parse to a non-negative integer (`Number.parseInt`, then
validate `Number.isInteger(n) && n >= 0`). Reject negative
values, non-numeric values, and fractional values with a stderr
message naming `--max-failures` and exit `1`.

### Restart-to-reset is implicit

The counter is a `Map` on the `Scheduler` instance. A fresh
autorun process constructs a fresh `Scheduler`, so the map starts
empty. No code is needed for the "reset" path beyond ensuring
the counter is purely in-memory.

### Filter / blocked / done precedence

The existing precedence chain in `decide()` is preserved:

1. `in-flight` (same-change collision in current session)
2. `filtered` (CLI `--filter` rejects)
3. `running-elsewhere` (orphan probe / running row)
4. `done`
5. `blocked` (deps unsatisfied)
6. `activity-succeeded`
7. **`failure-cap` (NEW)**
8. `concurrency`
9. `schedule`

Rationale: `failure-cap` is a "this brief is broken, don't keep
trying" signal. It should not preempt structural reasons (done,
blocked, filtered) because if those apply, the brief isn't even
a candidate this cycle. It should preempt `concurrency` because
a capped brief shouldn't displace concurrency slot accounting on
otherwise-ready briefs.

## Risks / Trade-offs

- **Missed failure increments on process crash**. If autorun
  crashes mid-run, the failure isn't counted. Acceptable: a
  crashed autorun is restarted anyway, which resets the map.
- **Counter and `runs.db` can drift**. The counter is per-session;
  `runs.db` is durable. An operator inspecting `runs.db` might
  see 50 failures and wonder why the cap fired at 3. The "restart
  to reset" gesture is documented; the docs explain that the cap
  is per-session, not historical.
- **Unknown-reason counts**. If a future runner emits a reason
  string that should arguably *not* count (some new
  process-kill category), it will count until the categorization
  list is extended. We accept this — false positives at the cap
  are recoverable via restart; false negatives (broken briefs
  hammering forever) are the bug we're trying to fix.

## Migration / Backwards compatibility

- Default `--max-failures 3` changes behavior: operators who
  rely on indefinite retry need to pass `--max-failures 0`.
- This is a deliberate default change called out in the ADR.
  The concept doc + CLI reference call out the override.
- No data migration; the feature is purely in-memory.

## Open questions resolved here

- **Should `user_quit` count?** No. It's a process-kill, not a
  brief-side failure. ADR locks this.
- **Reset gesture?** Restart autorun. No special CLI command.
