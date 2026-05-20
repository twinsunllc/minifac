---
change: run-history-persistence
factory: sdd
base_branch: main
---

## Background

Today minifac's daemon (`minifac serve`) tracks runs in an in-process
registry that evaporates on restart. `minifac run` invocations don't
persist anything at all. That's a real cost: the viewer can't show
prior runs, you can't query "what happened with change X three days
ago," and a future `auto-mode` (when it earns its way in) would have
nowhere to look for state. See
`docs/decisions/0011-SQLite-for-Runs.md` for the binding decision.

This change introduces a persistent runs database — SQLite at
`~/.minifac/runs.db` by default — and routes both `minifac run` and
`minifac serve` writes through it. The schema is deliberately shaped
so that future per-brief state (ready / in-progress / blocked / done,
dependencies) can extend the same DB without a new store.

## What to do

Read first:

- `docs/decisions/0011-SQLite-for-Runs.md` — binding decision
- `docs/concepts/Runs-DB.md` — concept with schema sketch
- `docs/decisions/0012-Where-State-Lives.md` — why the DB lives in `~/.minifac/`
- `docs/concepts/Run.md` — the Run lifecycle
- `docs/concepts/Runner.md` — what produces the events that go in the DB
- Existing canonical specs at `openspec/specs/` — especially
  `graph-runner/spec.md`, `run-cli/spec.md`, and the `serve-daemon`
  spec (the daemon already has a run registry; this change replaces
  its backing store)

Then implement what the decision describes. Concretely:

### 1. Pluggable storage interface

- Define a small `RunStore` interface (in `src/storage/` or similar)
  that the runner writes through:
  - `createRun(metadata) -> RunId`
  - `appendEvent(runId, event)`
  - `finalizeRun(runId, result)` (status, reason, proximate node,
    duration)
  - `getRun(runId)`, `listRuns({ filters })`, `getRunEvents(runId,
    { sinceSeq })`
- Use an async interface so future remote-backed adapters (Dolt,
  HTTP-backed, whatever) slot in cleanly without refactoring callers.
- One adapter ships: `SqliteRunStore` in `src/storage/sqlite.ts`.

### 2. SQLite adapter

- File path: `~/.minifac/runs.db` by default. Configurable via
  global `~/.minifac/config.yaml` (`runs_db: <path>`).
- Pick a no-native-build SQLite library — `better-sqlite3` is the
  standard choice but it's a native module; `bun:sqlite` doesn't apply
  (we're Node). Prefer `better-sqlite3` if it's already in the
  ecosystem; otherwise use Node 22's experimental `node:sqlite`
  built-in (available since Node 22). Document the choice.
- WAL mode (`PRAGMA journal_mode=WAL`) so concurrent CLI runs + the
  daemon can write without coordination.
- Schema (initial — refine as you implement):
  - `runs`: `id` (UUID), `factory_path`, `brief_path` (nullable for
    brief-less), `change` (nullable for brief-less), `factory_name`,
    `status` (`running` | `succeeded` | `failed`), `reason`,
    `proximate_node_id`, `started_at`, `ended_at`, `base_branch`,
    `worktree_path`
  - `events`: `run_id`, `seq` (monotonic per run), `node_id`,
    `iteration`, `kind` (`stdout` | `stderr` | `status`), `payload`
    (TEXT — JSON-encoded), `emitted_at`
  - `node_executions`: `run_id`, `node_id`, `iteration`, `status`,
    `started_at`, `ended_at`, `sentinel_status` (nullable),
    `exit_code` (nullable)
- A small migration mechanism (numbered SQL migrations applied at
  startup) so future schema changes don't break existing DBs.

### 3. Wire the runner + daemon through the store

- `src/runner/run.ts` (the in-process runner) takes an optional
  `RunStore` parameter. When provided, it writes a `runs` row at
  start, appends `events` rows as they arrive, and updates the row
  on completion.
- `src/cli.ts` constructs a SQLite-backed store and passes it to
  `runFactory`. The `minifac run` command now persists every run.
- `src/serve/run-registry.ts` swaps its in-memory event store for the
  SQLite-backed one. The daemon's HTTP/SSE surface is unchanged from
  the consumer's perspective — the daemon just reads from the DB now
  instead of memory.
- The viewer's "prior runs" affordance can now be implemented
  (currently the viewer only shows the active run). Add a
  `GET /api/runs` (or extend the existing list endpoint) to return
  the run history, sorted newest-first, with optional filters
  (factory name, change name, status). The viewer's HTML/JS gains a
  small "Recent runs" list section.

### 4. CLI: `minifac runs` subcommand

- New subcommand `minifac runs` for ad-hoc inspection from the
  terminal. Flags:
  - `--factory <name>` — filter by factory
  - `--change <name>` — filter by change
  - `--status <s>` — filter by status
  - `--limit <n>` — default 20
  - `--json` — emit JSON for piping
- Default output: a compact table (id short-prefix, change, factory,
  status, started_at, duration).
- `minifac runs show <id>` — show a single run's events streamed in
  order. `--follow` tails the event stream for an active run (uses
  the same DB poll the daemon does, or a `fs.watch` on the DB
  WAL — your call; if the latter is fragile, just poll every 250ms).

### 5. Configuration

- Optional `~/.minifac/config.yaml` field `runs_db: <path>` (sibling
  to the existing `worktrees_dir`).
- Per-repo `.minifac/config.yaml` MAY also override `runs_db` for
  test setups; main use case stays the global default.

### 6. Migration handling

- If `~/.minifac/runs.db` doesn't exist at startup, create it +
  apply all migrations.
- If it exists at an older schema version, apply pending migrations
  in order.
- A `minifac runs --json` against an old binary on a new DB SHALL
  refuse with a clear error (forward-compat is not v0's problem).

### Spec impact

Probably:

- NEW capability `run-storage` (or fold into `graph-runner` —
  judgment call) covering the `RunStore` interface, the SQLite
  schema, and the migration mechanism.
- `serve-daemon`: MODIFIED requirements to reflect that the daemon's
  run registry now persists. ADDED scenarios for prior-run replay
  across daemon restart.
- `run-cli`: ADDED requirements for the `runs` and `runs show`
  subcommands.
- `graph-runner`: MODIFIED requirement(s) for run-result emission to
  also persist through the store when one is provided. Backward
  compatible — runs without a store still work (used by tests).

Use your judgment on the breakdown. When MODIFYING, copy the entire
requirement block; do not partial-paste.

## Out of scope

- **Brief state (ready / in-progress / blocked / done) and
  dependencies.** Schema makes room for them; this change does NOT
  implement the state machine.
- **Auto-mode** (long-running minifac picking up ready work). Future.
- **A Dolt adapter, a Beads adapter, or any second storage backend.**
  Pluggable interface is real but only the SQLite adapter ships.
- **Sync across machines.** Run history is per-machine; if cross-
  machine sync becomes useful later, that's a separate change.
- **Old-run retention / pruning policy** (e.g., auto-delete runs
  older than N days). For v0 the DB grows unboundedly; `minifac prune
  --runs --older-than <duration>` is filed as an open question for
  a future enhancement, not implemented here.

## Acceptance criteria

- `minifac run <brief>` writes a `runs` row + per-event `events`
  rows to `~/.minifac/runs.db`
- `minifac serve` reads from the same DB so prior runs survive
  daemon restarts
- The web viewer shows a "Recent runs" list and lets the user click
  through to any prior run's event log
- `minifac runs` lists recent runs; `minifac runs show <id>` shows
  a single run's events
- Schema migrations apply automatically on startup
- All existing tests still pass; new tests cover the SQLite
  adapter, the migration mechanism, and the new CLI subcommand
- The `RunStore` interface is small enough that a future Dolt or
  HTTP-backed adapter could implement it without touching callers
