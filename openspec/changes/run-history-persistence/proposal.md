## Why

Run state lives in an in-process registry on the `serve` daemon and
nowhere at all for `minifac run`. The viewer can't show prior runs,
no one can ask "what happened with change X three days ago," and a
future auto-mode would have no durable state to anchor on. Decision
`docs/decisions/0011-SQLite-for-Runs.md` resolves this: persist run
history in SQLite at `~/.minifac/runs.db`, with room in the schema
for the brief-state extensions that follow.

## What Changes

- Introduce a pluggable `RunStore` interface that the runner writes
  through (`createRun`, `appendEvent`, `finalizeRun`, plus query
  methods). Async; single implementation in v0.
- Ship a SQLite adapter at `~/.minifac/runs.db` (configurable via
  `runs_db:` in `~/.minifac/config.yaml`). WAL mode so the CLI and
  the daemon can write concurrently without coordination.
- Wire `runFactory` to accept an optional store, persisting the
  run row at start, every event as it arrives, and the result on
  completion. Brief-less and store-less invocations still work
  (used by tests).
- Route `minifac run` and `minifac serve` through the store. The
  daemon's existing in-memory registry is replaced by a thin
  store-backed layer; runs survive daemon restarts.
- Apply numbered SQL migrations at process startup so future schema
  changes don't break existing DBs.
- Add `GET /api/runs` filter support and a "Recent runs" affordance
  to the viewer so prior runs are clickable.
- Add a `minifac runs` subcommand (list + show, with filters and
  optional `--follow` tail).

## Capabilities

### New Capabilities

- `run-storage`: the `RunStore` interface, the SQLite adapter,
  schema, and the migration mechanism.

### Modified Capabilities

- `graph-runner`: the runner SHALL accept an optional `RunStore`
  and, when provided, persist run metadata, every event, and the
  final result through it.
- `serve-daemon`: the run registry SHALL be backed by the store
  (runs persist across restarts); `GET /api/runs` SHALL support
  optional filters; the viewer SHALL surface prior runs.
- `run-cli`: a new `minifac runs` subcommand SHALL list and show
  runs from the store, with filters, `--json`, and `--follow`.

## Impact

- New deps: a SQLite library. Prefer Node 22's built-in
  `node:sqlite` so the package stays native-build-free; document
  the choice in `design.md`.
- New module: `src/storage/` (`run-store.ts` interface +
  `sqlite.ts` adapter + `migrations/`).
- Touched code: `src/runner/run.ts`, `src/cli.ts`,
  `src/cli/runs.ts` (new), `src/serve/run-registry.ts`,
  `src/serve/router.ts`, `src/serve/web/`, `src/worktree/config.ts`
  (one new optional field).
- New tests: SQLite adapter, migrations, `runs` subcommand,
  daemon prior-run replay, viewer prior-run list.
- No changes to factory or brief schemas.
- No changes to the executor interface.
