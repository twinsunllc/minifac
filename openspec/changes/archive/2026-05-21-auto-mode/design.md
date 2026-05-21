## Context

Decision [`0016-Auto-Mode`](../../../docs/decisions/0016-Auto-Mode.md)
pins the shape; this document pins how it lands inside the current
codebase.

Current state at the time of this proposal:

- `src/brief/state.ts` exposes `computeBriefState(change, {
  inputsDir, repoRoot, runStore, loadBrief? })` returning `{
  doneness, activity, deps, blocked, blockedReason }` plus a
  `BriefCycleError`. This is the autorun `ready` predicate's
  building block. (Shipped in [[0015-Brief-Deps-and-State]].)
- `src/brief/loader.ts` parses brief files; `src/brief/schema.ts`
  enforces the `depends_on: string[]` field with `[]` default.
- `src/cli/resolve.ts` is the existing run-action wiring — it
  resolves `<thing>` to a brief/factory, calls `computeBriefState`,
  refuses blocked briefs without `--force`, claims the lockfile,
  creates the worktree, invokes the runner, and finalizes the run.
  Autorun reuses this primitive (`runFactory` / `runBrief`
  equivalent) rather than re-implementing the run pipeline.
- `src/storage/run-store.ts` exposes `RunStore` with `listRuns`
  sorted by `started_at DESC`; the run-scoped branches column
  (`branch_name`) is populated.
- `src/cli/briefs.ts` already enumerates briefs from `<inputs>/*.md`
  and `<inputs>/done/*.md`, computes state per row, and filters by
  `--ready`. Autorun shares the enumeration+state-compute code with
  this subcommand (same loader, same state function); whether to
  refactor into a shared module is a tactical decision.
- `src/cli.ts` is the commander setup; adding `autorun` follows the
  same pattern as `briefs` / `runs`.

Constraints from `CLAUDE.md`:

- No premature subsystems. The autorun module lives next to the
  existing `src/cli/` directory, not a new `src/autorun/` package.
- No anthropomorphic metaphors. Naming: `Scheduler`, `pollOnce`,
  `inFlight`, not "worker" or "agent."
- No untyped runner registries. Autorun calls the existing run
  primitive directly.
- TypeScript strict mode; tests next to code.
- No new runtime dependencies.

## Goals / Non-Goals

**Goals:**

- A one-process command, `minifac autorun`, that picks up ready
  briefs and runs them with the same code path a manual `minifac
  run` would use.
- Observable, structured logs that make scheduling decisions
  reproducible (`started`, `skipped:<reason>`, `completed`,
  `failed` lines with timestamps and change names).
- Safe defaults: single-run concurrency (`--max-concurrent 1`),
  10-second poll interval, no `fs.watch` requirement.
- Composable with CI: `--once` runs everything that's ready right
  now and exits.
- Graceful: SIGINT lets in-flight runs finish; a second SIGINT (or
  `--force`) escalates.

**Non-Goals:**

- No background daemon coupling. `minifac serve --autorun` is a
  future ergonomic improvement and explicitly out of scope.
- No priority / scoring / topo-sort-with-weights. Oldest-ready-first
  is the v0 policy.
- No cost telemetry / spend caps. `--max-concurrent` is the only
  knob; `--max-spend-per-hour` waits for cost data per
  [[Open-Questions]].
- No mutation of brief files beyond what the runner already does
  (mark-done post-step, owned by the runner per
  [[0015-Brief-Deps-and-State]]).
- No caching of `computeBriefState` across polls. The predicate is
  cheap; the inputs are the truth.

## Decisions

### `minifac autorun` is a top-level subcommand, peer to `run`

Wired into commander in `src/cli.ts` alongside `run`, `runs`,
`briefs`, `prune`, etc. Long-running by default; exits when
in-flight runs settle after a stop signal, or when `--once` finishes
its single cycle, or when `--dry-run` finishes its single cycle.

### Flag surface

| Flag                   | Type   | Default      | Purpose                                               |
|------------------------|--------|--------------|-------------------------------------------------------|
| `--watch <dir>`        | path   | `./inputs`   | Inputs dir to poll                                    |
| `--max-concurrent <n>` | int    | `1`          | Parallel run cap                                      |
| `--interval <ms>`      | int    | `10000`      | Poll cadence in milliseconds                          |
| `--once`               | flag   | `false`      | One poll cycle, wait for runs, exit                   |
| `--filter <expr>`      | string | none         | Glob or `/regex/` against `change` name               |
| `--dry-run`            | flag   | `false`      | One poll cycle, print decisions, no runs              |
| `--json`               | flag   | `false`      | Emit log lines as JSON                                |
| `--force`              | flag   | `false`      | First signal kills child processes (no settle wait)   |

Validation:

- `--max-concurrent` SHALL be a positive integer; `0` or negative
  is a usage error (`exit 1`).
- `--interval` SHALL be a positive integer; `0` or negative is a
  usage error.
- `--filter` SHALL be either a non-empty string (glob) or a string
  of the shape `/<pattern>/<flags?>` (regex). Invalid regex is a
  usage error.
- `--once`, `--dry-run`, and the long-running mode are mutually
  exclusive in spirit but `--once --dry-run` is allowed (and means
  dry-run, since dry-run never schedules). The flag combination
  `--dry-run` implies `--once` semantics.

### Polling loop lives in `src/cli/autorun.ts`

Pseudocode for the main loop:

```ts
const scheduler = new Scheduler({
  runFactory,
  runStore,
  maxConcurrent: opts.maxConcurrent,
  logger,
});

let stopRequested = false;
let forceRequested = opts.force;

process.on("SIGINT", () => {
  if (stopRequested) forceRequested = true;
  stopRequested = true;
});
process.on("SIGTERM", () => {
  if (stopRequested) forceRequested = true;
  stopRequested = true;
});

const pollOnce = async () => {
  const briefs = await enumerateBriefs(opts.watch);
  const decisions = await Promise.all(
    briefs.map((b) => scheduler.decide(b, opts.filter)),
  );
  for (const d of decisions) {
    if (d.action === "schedule") scheduler.start(d.brief);
    else logger.log(d); // skipped:<reason>
  }
};

if (opts.dryRun) {
  await pollOnce({ dryRun: true });
  return 0;
}

await pollOnce();

if (opts.once) {
  await scheduler.drain();
  return 0;
}

while (!stopRequested) {
  await sleepUntil(opts.interval, { wakeOnFsEvent: true });
  if (stopRequested) break;
  await pollOnce();
}

if (forceRequested) {
  scheduler.killAllInFlight();
  return scheduler.anyKilled() ? 2 : 0;
}

await scheduler.drain();
return 0;
```

`enumerateBriefs(watchDir)` lists `<watchDir>/*.md`, returns each
with its `mtimeMs`, sorted ascending by `mtimeMs` then ascending by
`change` name for stable tiebreaks.

`Scheduler.decide(brief, filter)` returns one of:

- `{ action: "schedule", brief }` when the brief is ready, concurrency
  has room, and the filter (if any) matches.
- `{ action: "skip", reason: "filtered", brief }` when the filter
  rejects the brief.
- `{ action: "skip", reason: "blocked", brief, deps }` when
  `computeBriefState` reports `blocked`.
- `{ action: "skip", reason: "in-flight", brief }` when the change is
  already running in this autorun process (lockfile would also
  prevent it but we short-circuit to avoid lock contention noise).
- `{ action: "skip", reason: "activity-running", brief }` when the
  most recent run row for this change has `status === "running"` but
  is not tracked in our in-flight set (handles a parallel external
  invocation).
- `{ action: "skip", reason: "activity-succeeded", brief }` when the
  most recent run row has `status === "succeeded"` (we wait for the
  brief to be moved to `inputs/done/` by the runner's mark-done step;
  next poll will pick it up as `doneness: "done"` and naturally
  exclude it from the active set).
- `{ action: "skip", reason: "concurrency", brief }` when otherwise
  ready but no concurrency slot is available; the next poll will
  retry.
- `{ action: "skip", reason: "done", brief }` when the brief's
  `doneness === "done"` (already moved to `inputs/done/`; harmless
  but logged for traceability).

### Scheduler primitive lives in `src/cli/autorun-scheduler.ts`

```ts
export interface SchedulerDeps {
  runFactory: (args: RunFactoryArgs) => Promise<{ status: RunStatus; runId?: string }>;
  runStore: RunStore;
  inputsDir: string;
  repoRoot: string;
  maxConcurrent: number;
  logger: AutorunLogger;
}

export class Scheduler {
  constructor(deps: SchedulerDeps) { ... }
  decide(brief: Brief, filter?: AutorunFilter): SchedulerDecision;
  start(brief: Brief): void;          // fire-and-forget; updates in-flight set
  drain(): Promise<void>;             // resolves when in-flight is empty
  killAllInFlight(): void;            // SIGTERM child processes
  anyKilled(): boolean;
  inFlightCount(): number;
}
```

- `start` constructs the args for the existing run primitive — the
  same one `src/cli/resolve.ts` calls — and invokes it concurrently.
  Each `start` call increments the in-flight counter and decrements
  it on completion. The Scheduler holds a `Map<change, ChildHandle>`
  so signal escalation can kill executor children.
- `runFactory` is injected (not imported) so unit tests can swap a
  synchronous fake for the real `runFactory`.
- Concurrent runs proceed in separate worktrees. The per-change-name
  lockfile (per [[0009-Worktree-Default]]) prevents same-change
  collisions; cross-change concurrency is permitted up to
  `maxConcurrent`. [[Runs-DB]] handles concurrent writers via SQLite
  WAL.

### Selection order: oldest mtime first, lex tiebreak

```ts
function selectionOrder(briefs: BriefWithMtime[]): BriefWithMtime[] {
  return [...briefs].sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.change.localeCompare(b.change);
  });
}
```

The `[...briefs]` clone keeps the sort stable and side-effect-free.
Filesystem enumeration order (`fs.readdirSync`) is platform-dependent
and SHALL NOT be relied upon.

### Logging

The autorun logger is a small struct with two methods:

```ts
export interface AutorunLogger {
  log(event: AutorunEvent): void;
}

export type AutorunEvent =
  | { kind: "poll-start"; ts: number; briefs: number }
  | { kind: "started"; ts: number; change: string; runId?: string }
  | { kind: "skipped"; ts: number; change: string; reason: SkipReason; detail?: string }
  | { kind: "completed"; ts: number; change: string; runId?: string; status: "succeeded" | "failed" }
  | { kind: "dry-run-decision"; ts: number; change: string; action: "schedule" | "skip"; reason?: SkipReason };
```

- Default (human) format: `<ISO ts> <kind> <change>[ reason=<reason>][ detail=<detail>]`.
  Example: `2026-05-21T18:00:01Z started foo runId=run_abcd1234`.
- `--json` format: one JSON object per line with all the event
  fields serialized as-is plus `event` set to `kind`.

### Graceful shutdown

First SIGINT/SIGTERM:

1. Set `stopRequested = true`.
2. Stop the poll loop.
3. Wait for `scheduler.drain()` (in-flight runs settle).
4. Exit `0`.

Second SIGINT (or first SIGTERM with `--force`):

1. Set `forceRequested = true`.
2. Call `scheduler.killAllInFlight()` which sends SIGTERM to each
   tracked child executor process (PID stored on the `ChildHandle`
   the run primitive returns).
3. Wait briefly for the children to exit, then exit non-zero (`2`).

`--force` from the start means SIGINT immediately kills children
instead of waiting; this is the CI escape hatch.

### `--once` mode

Equivalent to:

1. One full `pollOnce()`.
2. `scheduler.drain()` — wait for scheduled runs to finish.
3. Exit `0`.

A SIGINT during `--once` still escalates the same way; `--once` is
primarily an exit-condition, not a separate code path.

### `--dry-run` mode

One `pollOnce({ dryRun: true })`. The scheduler emits
`dry-run-decision` events for every brief, indicating whether it
would be scheduled or skipped (and the reason), but NEVER calls
`runFactory`. Exits `0`.

### `--filter` semantics

```ts
export interface AutorunFilter {
  match(change: string): boolean;
}

export function parseFilter(expr: string | undefined): AutorunFilter | undefined;
```

- A string of the form `/<pattern>/<flags?>` is interpreted as a
  regex (constructed with `new RegExp(pattern, flags)`). An invalid
  regex is a usage error.
- Any other non-empty string is interpreted as a glob using a tiny
  built-in glob-to-regex helper that supports `*` (any-chars-except
  `/`), `?` (single char), and literal text. No `{a,b}` or `**` —
  brief change names are flat strings, no path semantics.
- Filter is matched against the `change` value (the slug), not the
  file path.

### Interaction with the runner's mark-done post-step

The runner already (per [[0015-Brief-Deps-and-State]]) moves a brief
from `inputs/<change>.md` to `inputs/done/<change>.md` on
terminal-success. Autorun's enumeration scans `<watch>/*.md`, NOT
`<watch>/done/*.md`, so a `done` brief naturally drops out of the
candidate set on the next poll.

A succeeded brief that hasn't yet been moved (e.g. the mark-done
step's `git mv` failed and emitted a warning) will be picked up
again on the next poll. The Scheduler's `activity-succeeded` skip
reason absorbs this case: a brief still in `inputs/<change>.md` with
its most recent run row `succeeded` is skipped (not re-run) and
logged with that reason. Human follow-up moves it manually.

### Interaction with the lockfile

The Scheduler's `inFlight` map is an in-process optimization; the
ground-truth concurrency guard is still the per-change-name
lockfile in `runFactory`. If two `minifac autorun` processes happen
to run against the same repo, the second one's `runFactory` call
for a shared change will fail to claim the lock and surface as a
`failed` start event. Autorun does not specifically handle this —
it's the same behavior the user gets today running two `minifac
run` commands concurrently on the same change.

### Long-running brief enumeration on a busy repo

Per [[0016-Auto-Mode]]'s performance budget: a poll over ~200
briefs SHOULD complete in <100ms. Each poll does:

- One `fs.readdirSync` on the watch dir (cheap).
- One `fs.statSync` per brief for mtime (~negligible on local
  disk).
- One `readBrief` per brief (for `depends_on`).
- One `computeBriefState` per brief, which queries `listRuns({
  change, limit: 1 })` per brief.

That last step is the dominant cost. A 200-brief poll issues 200
small `listRuns` queries against SQLite. SQLite's WAL mode handles
this comfortably; if profiling reveals a bottleneck the response is
batched activity lookup (one query keyed by `change IN (?, ?, ...)`
returning the most-recent row per change), not stored state.

This v0 ships with one-query-per-brief. Optimization is deferred
until a real backlog hits the ceiling.

### `fs.watch` is a wake-up hint, not the load-bearing mechanism

Polling at `--interval` is always running. If `fs.watch(watchDir)`
attaches cleanly, an event triggers an early `pollOnce()` (subject
to a 250ms debounce to coalesce rapid-fire events). If `fs.watch`
throws or behaves erratically (some platforms / network mounts), it
is best-effort — autorun catches the error, logs it once at startup
in `--json` mode (or omits the noise otherwise), and falls back to
plain polling.

## Alternatives considered

- **Implement autorun as a daemon-side mode** (`minifac serve
  --autorun`). Rejected per 0016 — coupling autorun to the viewer
  daemon means you can't have the build farm without the GUI.
  Standalone command first; daemon wrapper later if it earns
  integration.
- **Priority / scoring scheduling.** Rejected per 0016 — oldest-mtime
  is good enough for the common case (the brief file is the
  intent's timestamp).
- **Watch only, no polling.** Rejected per 0016 — `fs.watch` is
  cross-platform fragile; polling is the safety net.
- **One `listRuns` call per change** (vs a batched `listRuns({
  changeIn: [...] })`). Kept as the v0 choice; batched lookup is a
  future optimization once profiling demands it.
- **Materialize a `ready_briefs` view in SQLite.** Rejected —
  introduces a new sync surface; the predicate is fast enough today.
- **Track in-flight runs via the lockfile alone.** Rejected — the
  in-process `inFlight` map enables faster decisions and clearer
  skip reasons in logs. Lockfile remains the cross-process truth.
- **Fail the autorun process when a single run fails.** Rejected —
  the build farm vision requires fault isolation. Failed briefs
  block their dependents naturally; unrelated work continues.
- **Use `child_process.spawn` per scheduled run instead of an
  in-process call to `runFactory`.** Rejected — adds a wholly
  separate IPC + lifecycle path. The existing run primitive is
  in-process and isolation is already provided by worktrees.

## Risks / Trade-offs

- **Drift between `inFlight` map and actual run state.** Mitigation:
  the lockfile is still authoritative; `inFlight` is an optimization.
  A crash mid-run leaves a stale lockfile that lazy-prune (per
  `worktree-management`) cleans up; autorun does not own that cleanup.
- **A spinning brief that keeps failing.** Autorun keeps re-running
  it every poll (since `activity === "failed"` is a retry condition).
  The fix is human triage — author moves it to `inputs/done/` to
  defer it, or fixes the brief, or removes it. A backoff is
  deferred; in practice the user notices because the JSON log line
  cadence is loud.
- **`--max-concurrent` larger than the number of CPU cores.** Each
  run is mostly waiting on Claude; CPU is not the limit. The user is
  responsible for picking a value that fits their budget.
- **A brief's `depends_on` references a brief that doesn't exist.**
  `computeBriefState` reports `doneness: "missing"` for the dep;
  the brief is `blocked`; autorun skips it with `reason: "blocked"`
  every poll until the user intervenes. (Surfaces a typo loudly,
  which is the desired behavior.)
- **SIGINT arrives during `runFactory`'s lockfile claim.** The
  in-flight set may not yet include the run. The drain still works
  because `runFactory` returns a promise the Scheduler awaits; the
  signal handler waits on the same promise pool.
- **A platform where SIGTERM-on-child does not propagate cleanly to
  the claude executor.** The Scheduler's `killAllInFlight` sends
  SIGTERM; if the child traps and exits cleanly, we still record
  the run as `failed`. If the child blocks indefinitely, the user
  gets to send a third SIGINT to the autorun process itself — at
  which point Node's signal default terminates the parent and the
  OS reaps orphans.

## Migration notes

- No schema or storage changes. `runs.db` is unchanged; brief
  schema is unchanged (already has `depends_on`).
- Existing `minifac run` users are unaffected — autorun is purely
  additive.
- CI users who want a "process the backlog" step can replace a
  loop-of-`minifac-run` shell script with `minifac autorun --once
  --json`.
- Operators who want the daemon UI to surface autorun activity get
  it free: every autorun-scheduled run lands in [[Runs-DB]] like
  any other run.
