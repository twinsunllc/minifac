## Context

Today `minifac serve` keeps run state in `src/serve/run-registry.ts`
— an in-memory map of `RunRecord` keyed by id. `minifac run`
keeps no state at all. The viewer can show prior runs only for the
current daemon process; restart and they're gone. There's no way
to query across runs.

Decision `0011-SQLite-for-Runs.md` is binding: SQLite at
`~/.minifac/runs.db`, schema with room to extend for brief state
when `auto-mode` arrives, pluggable interface so future Dolt or
HTTP adapters can slot in without touching callers. Decision
`0012-Where-State-Lives.md` places the DB in `~/.minifac/`
alongside worktrees and locks (machine-state, not in git).

## Goals / Non-Goals

**Goals:**

- Persist every run (CLI and daemon) to a single SQLite file with
  a documented schema and a numbered migration mechanism.
- Keep the storage interface small enough that a future remote-
  backed adapter (Dolt, HTTP, S3-Tail, etc.) implements it
  without touching the runner or the daemon.
- Daemon survives restarts: prior runs and their event logs stay
  visible in the viewer and via `GET /api/runs/:id`.
- New CLI surface (`minifac runs`, `minifac runs show <id>`) for
  ad-hoc inspection from the terminal.
- Concurrent writers (CLI + daemon) coexist without coordination
  via SQLite WAL mode.

**Non-Goals:**

- Brief state (`ready`, `in-progress`, `blocked`, `done`) and
  brief dependencies. The schema reserves the shape; the state
  machine is the next change.
- A second storage adapter. The interface is pluggable so a Dolt
  or Beads adapter could slot in later; only SQLite ships here.
- Cross-machine sync of run history.
- Retention / pruning policy for old runs. The DB grows
  unboundedly in v0; an explicit `minifac prune --runs` is a
  filed open question, not in this change.
- Authentication or remote access to the DB.

## Decisions

### SQLite library

Prefer Node 22's built-in `node:sqlite`. The project's
`engines.node` is already `>=22.0.0` and the built-in carries no
native-build cost or extra dependency. If a missing feature
forces it (e.g. richer prepared-statement API), fall back to
`better-sqlite3`; document the choice in the adapter file. WAL
mode is enabled at open (`PRAGMA journal_mode=WAL`) so concurrent
CLI runs and the daemon never block each other.

### File location

`~/.minifac/runs.db` by default. `~/.minifac/config.yaml` gains an
optional `runs_db:` field that overrides the default. Per-repo
`.minifac/config.yaml` MAY also set `runs_db:` for test setups; the
machine-state primary path is the global default. `MINIFAC_HOME`
overrides (already wired for worktrees / locks) covers tests that
want to redirect everything to a tmp dir.

### Schema (v1)

```
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE runs (
  id                TEXT PRIMARY KEY,        -- UUID v4
  factory_path      TEXT NOT NULL,           -- absolute on-disk path at run start
  factory_name      TEXT NOT NULL,           -- factory.name from YAML
  brief_path        TEXT,                    -- nullable for brief-less runs
  change            TEXT,                    -- brief.change (nullable for brief-less)
  base_branch       TEXT,                    -- nullable
  worktree_path     TEXT,                    -- nullable for in-place runs
  status            TEXT NOT NULL,           -- 'running' | 'succeeded' | 'failed'
  reason            TEXT,                    -- terminal_node_succeeded | node_failed | budget_exhausted | graph_drained | unknown_executor
  proximate_node_id TEXT,                    -- nullable
  started_at        INTEGER NOT NULL,        -- epoch ms
  ended_at          INTEGER                  -- epoch ms; null while running
);

CREATE INDEX runs_started_at_idx ON runs (started_at DESC);
CREATE INDEX runs_factory_idx     ON runs (factory_name, started_at DESC);
CREATE INDEX runs_change_idx      ON runs (change,       started_at DESC);

CREATE TABLE events (
  run_id     TEXT    NOT NULL,
  seq        INTEGER NOT NULL,                -- monotonic per run, starts at 0
  node_id    TEXT,                            -- null for synthetic markers
  iteration  INTEGER NOT NULL,
  kind       TEXT    NOT NULL,                -- 'stdout' | 'stderr' | 'status' | 'run_end'
  payload    TEXT    NOT NULL,                -- JSON-encoded payload
  emitted_at INTEGER NOT NULL,                -- epoch ms
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE node_executions (
  run_id           TEXT    NOT NULL,
  node_id          TEXT    NOT NULL,
  iteration        INTEGER NOT NULL,
  status           TEXT    NOT NULL,          -- 'running' | 'succeeded' | 'failed' | 'skipped'
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  sentinel_status  TEXT,
  exit_code        INTEGER,
  PRIMARY KEY (run_id, node_id, iteration)
);
```

`node_executions` is denormalized from `events` for query
ergonomics ("show me all failed `verify` nodes this month"
without scanning every event row). Updated at node-start and
node-end via dedicated store calls.

`events.payload` is JSON to keep the schema stable as event
shapes evolve. Readers JSON-decode for display.

### `RunStore` interface

```ts
export type RunId = string;

export interface CreateRunInput {
  id: RunId;
  factoryPath: string;
  factoryName: string;
  briefPath?: string | null;
  change?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
  startedAt: number;
}

export interface StoredEvent {
  seq: number;            // assigned by the store
  nodeId: string | null;
  iteration: number;
  kind: "stdout" | "stderr" | "status" | "run_end";
  payload: unknown;       // JSON-serializable
  emittedAt: number;
}

export interface AppendEventInput {
  nodeId: string | null;
  iteration: number;
  kind: "stdout" | "stderr" | "status" | "run_end";
  payload: unknown;
  emittedAt: number;
}

export interface FinalizeRunInput {
  status: "succeeded" | "failed";
  reason?: string | null;
  proximateNodeId?: string | null;
  endedAt: number;
}

export interface ListRunsFilter {
  factoryName?: string;
  change?: string;
  status?: "running" | "succeeded" | "failed";
  limit?: number;          // default 20
  offset?: number;
}

export interface StoredRun {
  id: RunId;
  factoryPath: string;
  factoryName: string;
  briefPath: string | null;
  change: string | null;
  baseBranch: string | null;
  worktreePath: string | null;
  status: "running" | "succeeded" | "failed";
  reason: string | null;
  proximateNodeId: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface RunStore {
  createRun(input: CreateRunInput): Promise<void>;
  appendEvent(runId: RunId, event: AppendEventInput): Promise<StoredEvent>;
  recordNodeStart(runId: RunId, nodeId: string, iteration: number, at: number): Promise<void>;
  recordNodeEnd(
    runId: RunId,
    nodeId: string,
    iteration: number,
    end: { status: "succeeded" | "failed" | "skipped"; sentinelStatus?: string | null; exitCode?: number | null; at: number },
  ): Promise<void>;
  finalizeRun(runId: RunId, input: FinalizeRunInput): Promise<void>;
  getRun(runId: RunId): Promise<StoredRun | null>;
  listRuns(filter?: ListRunsFilter): Promise<StoredRun[]>;
  getRunEvents(runId: RunId, opts?: { sinceSeq?: number; limit?: number }): Promise<StoredEvent[]>;
  close(): Promise<void>;
}
```

Async on every method so a future remote adapter doesn't need to
break callers when it lands.

### Runner integration

`runFactory(loaded, { ..., store })`. When `store` is provided:

1. Before the first node runs, runner calls `store.createRun(...)`
   with the metadata it has in scope (factory name + path, brief
   path/change if any, `runCwd` as `worktreePath` for worktree-
   mode runs, `baseBranch` from the brief if present, `startedAt`).
2. Every event the runner records into the in-memory history is
   also passed to `store.appendEvent(...)` in order.
3. `recordNodeStart` / `recordNodeEnd` bracket each node dispatch.
4. On terminal status, the runner calls `store.finalizeRun(...)`
   with the structured result.

The store is optional. Tests that don't care about persistence
omit it and the runner behaves exactly as today.

### Daemon integration

`RunRegistry` keeps its public shape (`list`, `get`, `start`,
`subscribe`, `closeAllSubscribers`) but its backing storage moves
to the `RunStore`. The in-memory subscriber set stays — it's a
fan-out tracker, not a persistence concern — but `recordEvent` /
`recordResult` write through to the store *and* fan out.

On daemon start, the registry seeds itself from
`store.listRuns({ limit: <bounded> })` so the viewer can show
prior runs immediately. Active runs that the previous daemon
process left in `running` status are *not* resumed (the runner
process is dead); the daemon marks them `failed` with reason
`daemon_restart` on first sight to keep the registry honest.

### Migration mechanism

Numbered SQL files in `src/storage/migrations/0001_initial.sql`,
`0002_*.sql`, … applied in order at adapter `open`. Adapter
reads `schema_version`, applies any whose version is greater than
the current value, in a transaction per file. v0 ships
`0001_initial.sql` with the schema above.

A binary that finds a `schema_version` higher than the highest
migration it carries SHALL exit non-zero with a clear error — we
don't try to be forward-compatible across our own upgrades in v0.

### `minifac runs` CLI

- `minifac runs` — list, default limit 20, default ordering
  `started_at DESC`. Filters: `--factory <name>`, `--change <name>`,
  `--status <s>`, `--limit <n>`. Default output is a compact table;
  `--json` emits JSON for piping.
- `minifac runs show <id>` — print the run's event log in
  `seq` order. Accepts a short-prefix id when unambiguous.
  `--follow` tails the event stream for an active run via polling
  the store every 250 ms.

### Viewer affordance

`GET /api/runs` already returns the registry's runs. With the
store backing it, the same endpoint now reflects prior runs.
Filters (`?factory=…`, `?change=…`, `?status=…`, `?limit=…`) are
optional and additive — existing clients are unaffected.

The viewer gains a "Recent runs" section that calls
`GET /api/runs?limit=20`. Clicking a prior run scrolls the
existing event-list pane to that run's events (fetched via
`GET /api/runs/:id`). No new pages — keep it one viewer.

## Risks / Trade-offs

- **Native-build risk.** `node:sqlite` is the right call for
  staying native-build-free, but it's still flagged as
  experimental in some Node 22 releases. Mitigation: pin to the
  built-in, document the choice, and have `better-sqlite3` as a
  fallback noted in `design.md`. The interface is async so a
  swap is cheap.
- **Schema lock-in.** Renaming a column later means a migration
  every consumer must run. Mitigation: keep payload-heavy data
  in `events.payload` as JSON, only normalize what we actually
  query on.
- **DB grows unboundedly.** v0 has no retention. Mitigation: the
  open question (`minifac prune --runs --older-than`) is filed.
  Real users won't hit this in months.
- **Concurrent writers under WAL.** SQLite WAL handles multiple
  writers, but only one transaction at a time. Long event bursts
  from the runner could block a CLI `minifac runs` query. Mitig-
  ation: keep each write transaction tiny (one row), batch only
  if profiling shows the need.
- **Replaying a `running` row across daemon restart is wrong.**
  We mark these `failed` with `reason: "daemon_restart"` on first
  sight. Alternative was to leave them as-is and confuse the
  viewer; calling them out is honest and queryable.
