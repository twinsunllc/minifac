## 1. Storage interface and SQLite adapter

- [x] 1.1 Add `src/storage/run-store.ts` defining the `RunStore`
      interface, `CreateRunInput`, `AppendEventInput`,
      `FinalizeRunInput`, `ListRunsFilter`, `StoredRun`, and
      `StoredEvent` types per `design.md`.
- [x] 1.2 Add `src/storage/migrations/0001_initial.sql` with the
      v1 schema: `schema_version`, `runs`, `events`,
      `node_executions`, plus the three documented indexes.
- [x] 1.3 Add `src/storage/sqlite.ts` implementing the `RunStore`
      interface against Node 22's built-in `node:sqlite`. Open
      with `journal_mode=WAL` and `foreign_keys=ON`. Lazy-create
      the file and any parent directories.
- [x] 1.4 Add a migration runner that reads `schema_version`,
      applies pending migrations in order in per-file
      transactions, and refuses to open a database whose version
      exceeds the binary's highest migration.
- [x] 1.5 Tests in `src/storage/sqlite.test.ts`: WAL mode is
      enabled at open, fresh DB applies all migrations, newer DB
      is refused, concurrent `appendEvent` from two opens against
      the same file all land, `seq` is monotonic per run.

## 2. Configuration plumbing

- [x] 2.1 Extend `src/worktree/config.ts` (rename if it becomes
      too worktree-specific; otherwise keep) to load an optional
      `runs_db` field. Validate it as a non-empty string per the
      `run-storage` spec; resolve relative paths against the
      config file's directory.
- [x] 2.2 Default to `${MINIFAC_HOME}/runs.db` when `runs_db` is
      absent.
- [x] 2.3 Add a small helper (`openDefaultRunStore(cwd)`) that
      builds the SQLite adapter from merged config + env, used
      by both the CLI and the daemon.
- [x] 2.4 Tests for config loader: default path, global override,
      per-repo override, error on empty / non-string value.

## 3. Runner integration

- [x] 3.1 Extend `runFactory(...)` in `src/runner/run.ts` to
      accept an optional `store` option (typed against the
      `RunStore` interface).
- [x] 3.2 When `store` is provided: generate a run id, call
      `store.createRun(...)` before the first node dispatch with
      factory path/name, optional brief path/change, optional
      `worktreePath` (from `runCwd`), optional `baseBranch`, and
      `startedAt`.
- [x] 3.3 Pipe every emitted `RunHistoryEntry` through
      `store.appendEvent(...)` in the same order as `onEvent`.
- [x] 3.4 Bracket each node dispatch with `recordNodeStart` /
      `recordNodeEnd`, including the budget-skip path so the
      `node_executions` row reflects that the node was skipped.
- [x] 3.5 Call `store.finalizeRun(...)` exactly once on
      termination with the structured result (status, reason,
      `proximateNodeId`, `endedAt`).
- [x] 3.6 Tests in `src/runner/run.test.ts`: store optional;
      with-store success path; with-store budget-exhausted path;
      with-store node-failed path; event order matches in-memory
      history.

## 4. CLI: `minifac run` wires the store

- [x] 4.1 In `src/cli.ts`, construct a `RunStore` once per
      `run` invocation via the helper from 2.3 and pass it to
      `runFactory`.
- [x] 4.2 Ensure the store is closed in the existing
      `try/finally` after the run finishes (success or failure),
      alongside lock release.
- [x] 4.3 Tests: a `minifac run` invocation creates exactly one
      `runs` row, N `events` rows in order, and the row reaches
      a terminal status by the time the CLI exits.

## 5. Daemon integration

- [x] 5.1 Refactor `src/serve/run-registry.ts` to take an
      injected `RunStore` and route durable state through it:
      `start` calls `createRun`; `recordEvent` writes both the
      subscriber fan-out and `appendEvent`; `recordResult` calls
      `finalizeRun`.
- [x] 5.2 On daemon startup, seed the in-memory registry from
      `store.listRuns({ limit: <bounded> })`. Sweep any
      `running` rows to `failed` with reason `daemon_restart`
      and reflect that update in both the store and the in-
      memory map.
- [x] 5.3 `GET /api/runs/:id` reads from the store when the run
      is not in the in-memory cache (i.e. prior runs from earlier
      daemon processes).
- [x] 5.4 Tests in `src/serve/run-registry.test.ts`: cold start
      with prior runs present in the store; orphaned `running`
      sweep on startup; events from a prior run are returned by
      `GET /api/runs/:id`.

## 6. Daemon HTTP filters

- [ ] 6.1 Extend the `GET /api/runs` handler to parse
      `factory`, `change`, `status`, and `limit` query parameters
      and pass them as `ListRunsFilter` to the store.
- [ ] 6.2 Reject invalid `limit` (non-positive, non-numeric,
      above ceiling) with HTTP 400 + JSON body.
- [ ] 6.3 Tests in `src/serve/router.test.ts` /
      `src/serve/server.test.ts` covering each filter and the
      400 path.

## 7. Viewer: "Recent runs"

- [ ] 7.1 In `src/serve/web/`, add a Recent runs section that
      fetches `GET /api/runs?limit=20` on load and renders the
      list (factory id, change, status, startedAt).
- [ ] 7.2 Clicking an entry calls `GET /api/runs/:id` and
      renders that run's persisted events in the existing event-
      tail pane (no new run, no POST).
- [ ] 7.3 Manual smoke check with `minifac serve` against a
      pre-seeded `runs.db`.

## 8. CLI: `minifac runs` subcommand

- [ ] 8.1 Add `src/cli/runs.ts` with `listAction` and `showAction`.
- [ ] 8.2 Wire `program.command("runs")` in `src/cli.ts` with
      `--factory`, `--change`, `--status`, `--limit`, `--json`.
      Default output is a table; sort by `startedAt DESC`.
- [ ] 8.3 Add `program.command("runs show <id>")` with
      `--follow` and `--json`. Resolve id via exact match or
      unambiguous prefix; usage-error on ambiguous or unknown.
- [ ] 8.4 `--follow` polls the store every ~250 ms until the
      run is terminal. Skip polling when the run is already
      terminal at first read.
- [ ] 8.5 Tests in `src/cli/runs.test.ts`: list happy path,
      each filter, `--json` shape, `--limit` rejection, `show`
      with full id, `show` with prefix, ambiguous prefix,
      unknown id, `--follow` against a terminal run, `--follow`
      against a running run (using an in-test store that
      flushes events between polls).

## 9. Documentation

- [ ] 9.1 Update `README.md` so the `minifac serve` and
      `minifac run` sections mention the persisted runs.db.
- [ ] 9.2 Add a short `minifac runs` section to `README.md`.
- [ ] 9.3 Spot-check `docs/concepts/Runs-DB.md` and
      `docs/concepts/Run.md` against the shipped schema; update
      either doc only if the implementation diverged from the
      sketch.

## 10. Verification

- [ ] 10.1 `npm run test` passes.
- [ ] 10.2 `npm run check` passes (biome lint + format).
- [ ] 10.3 Manual: `minifac run hello` (or similar) then
      `minifac runs` shows the run; `minifac runs show <id>`
      replays the events; `minifac serve` restart preserves the
      run in the viewer.
