## 1. Daemon scaffolding and CLI wiring

- [x] 1.1 Add `src/serve/server.ts` exporting a `startDaemon({ dir, host, port })` function that returns a handle with `.close()`. The function builds an `http.Server` on `node:http`, binds the given host:port (refusing non-loopback hosts), and resolves once listening.
- [x] 1.2 Add `src/serve/router.ts` implementing a tiny method+path router (literal segments and `:param` segments only). Cover with unit tests in `src/serve/router.test.ts`.
- [x] 1.3 Wire a new `serve` subcommand in `src/cli.ts` that calls `startDaemon` with parsed `--port` (default `4280`), `--host` (default `127.0.0.1`), and the positional directory argument (default `.`). On SIGINT / SIGTERM, call `.close()` and exit `0`. Extend `src/cli.test.ts` with at least a help-text scenario.

## 2. Factory discovery

- [x] 2.1 Add `src/serve/factories.ts` exporting a `FactoryWatcher` that scans the given directory for `*.yaml` and `*.yml` files at startup and watches for changes via `fs.watch`.
- [x] 2.2 For each discovered path the watcher calls the existing `loadFactory` and stores either `{ id, path, name, factory }` on success or `{ id, path, error }` on failure. Deduplicate by basename; warn to stderr on collisions.
- [x] 2.3 Add `src/serve/factories.test.ts` covering: initial scan picks up valid factories, invalid factories appear with `error` set, new file appearing post-startup is eventually picked up.

## 3. Run registry

- [x] 3.1 Add `src/serve/run-registry.ts` exporting a `RunRegistry` class. It owns: a map of run id → `RunRecord` (`{ id, factoryId, status, startedAt, endedAt?, result?, events: EventEntry[] }`), and per-run subscriber sets.
- [x] 3.2 `start({ factoryId, cwd? }, factory)` creates a record (refuses if another run for the same factory is `running`), spawns `runFactory(...)` from `src/runner/run.js`, and pipes each event through `recordEvent`. Each `EventEntry` gets a monotonic `index` (per run, starting at 0).
- [x] 3.3 `recordEvent(runId, entry)` appends to the run log and fans the entry out to every subscriber. On the final runner result, set `endedAt` and `result`, status to `succeeded` or `failed`, and emit a synthetic `run_end` entry to subscribers.
- [x] 3.4 `subscribe(runId, lastIndex?, sink)` replays buffered entries with `index > (lastIndex ?? -1)` synchronously, then attaches the sink for live entries. Returns an unsubscribe handle.
- [x] 3.5 Cover with `src/serve/run-registry.test.ts`: lifecycle moves `pending → running → succeeded`, second run for same factory while first is running returns a conflict, mid-run subscribe replays buffered events, `run_end` is emitted on completion.

## 4. SSE writer

- [x] 4.1 Add `src/serve/sse.ts` exporting an `sseResponse(res)` helper that sets headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`), disables Nagle, writes a comment `: ok\n\n` to flush headers, and exposes `.send(event, data, id)` and `.close()`.
- [x] 4.2 Cover with `src/serve/sse.test.ts`: frame format is `id: <n>\nevent: <kind>\ndata: <json>\n\n`, helper closes cleanly.

## 5. HTTP routes

- [x] 5.1 Implement `GET /api/factories` returning `{ factories: [...] }`.
- [x] 5.2 Implement `GET /api/factories/:id` returning the parsed factory shape, `422` for known-but-broken, `404` otherwise.
- [x] 5.3 Implement `GET /api/runs` and `GET /api/runs/:id` returning metadata and accumulated event log.
- [x] 5.4 Implement `POST /api/runs` reading the JSON body (`factoryId`, optional `cwd`). Validate `cwd` is absolute when present; return `400` on rejection. Returns `201` with `{ id, ... }` on success, `404` for unknown factory, `409` with `activeRunId` when a run for that factory is already running.
- [x] 5.5 Implement `GET /api/runs/:id/events`: subscribe via the registry (using `Last-Event-ID` header when present), stream entries as SSE frames, emit a `run_end` frame on completion, close the connection cleanly when the client disconnects.
- [x] 5.6 Implement the static handler at `/` and unmatched non-`/api` paths: serve files from `src/serve/web/` (resolved relative to the built output at runtime), refuse path traversal with `403`, return `404` for missing files, default to `index.html` on bare `/`.
- [x] 5.7 Return `405` for known paths invoked with the wrong method, `404` for unknown `/api/` paths.
- [x] 5.8 Add `src/serve/server.test.ts` covering each route above with an in-process daemon (`startDaemon` against an ephemeral port).

## 6. Static viewer

- [x] 6.1 Add `src/serve/web/index.html`: shell with a factories sidebar, a main pane with a graph SVG container and an event-tail `<pre>`, a "Start run" button. No remote scripts.
- [x] 6.2 Add `src/serve/web/app.js` (ES module): fetches `/api/factories`, renders the list, selects one, fetches `/api/factories/:id`, renders the graph as inline SVG via a small layered layout, wires the start-run button to POST `/api/runs`, and opens `EventSource` against `/api/runs/:id/events` to feed both the per-node status indicators and the event tail.
- [x] 6.3 Add `src/serve/web/style.css`: minimal styling for the layout, node statuses, and event tail. No framework.
- [x] 6.4 Ensure `tsconfig.json` (or a small post-build step) copies `src/serve/web/**` to `dist/serve/web/`. Verify by inspecting `dist/` after `npm run build`.

## 7. Documentation

- [x] 7.1 Update `README.md` with a `minifac serve` section: how to start the daemon, the default host:port, what the viewer shows, the explicit "localhost-only, no auth" posture, and a pointer to `examples/sdd.md` for which factories to point it at.
- [x] 7.2 Add a one-line entry near `minifac run` describing `minifac serve` so the two are discoverable side by side.

## 8. Validation

- [x] 8.1 Run `openspec validate serve-and-viewer` to a clean exit.
- [x] 8.2 Run `npm run check` and `npm test` to a clean exit.
- [x] 8.3 Manual smoke test: `minifac serve examples/`, open the viewer at `http://127.0.0.1:4280`, pick `hello`, click Start, watch events stream.
