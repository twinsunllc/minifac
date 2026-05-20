## Why

`minifac run` is great for one-shot terminal usage, but the dogfood loop
needs eyes on what's happening: which node is running, what it's
streaming, why a cycle bounced. Tail-following a single terminal pipe is
fine for the trivial `hello.yaml`; for `sdd.yaml` it is already painful
(four nodes, a retry cycle, multiple iterations interleaving stdout).

A local web viewer that shows the graph, per-node status, and a live
stream of node events is the minimum useful affordance, and the runner
already emits exactly the event shape a viewer needs (`stdout`,
`stderr`, `status` per `nodeId` and `iteration` — see `graph-runner`).
This change adds a `minifac serve` daemon that exposes that stream over
HTTP and ships a tiny static viewer that consumes it.

The daemon also acts as the first hosting surface for future work
(persistent run history via beads + dolt, multi-run dashboards, run
controls). v0 deliberately ships only the live-run slice so we can
validate the shape before investing in the rest.

## What Changes

- **New CLI subcommand `minifac serve`.** Starts a long-running local
  daemon. Takes a positional directory argument (defaults to `.`) which
  it watches for `*.yaml` factory files. Accepts `--port` (default
  `4280`) and `--host` (default `127.0.0.1`, localhost-only).
- **HTTP API on the daemon.** Read-only endpoints to list factories,
  read a factory's parsed shape, list active runs, fetch a run's
  accumulated history; one POST endpoint to start a run; and an SSE
  endpoint to stream a run's live events. Bound to `127.0.0.1` only.
- **Static web viewer at `/`.** A single HTML page plus a small amount
  of vanilla JS that lists the factories in the watched directory,
  renders the selected factory's graph (nodes + edges + per-node
  status), and tails the active run via SSE. A "Start run" button
  POSTs to the start endpoint. No build step; ships as static assets
  served by the daemon.
- **Run registry inside the daemon.** Ephemeral, in-process. Each
  started run gets a server-generated id; events are buffered per run
  so a viewer that connects mid-run gets the history then tails new
  events. Closing the daemon loses all run state — persistent storage
  is explicitly a separate change.
- **The runner is unchanged.** `minifac serve` calls the same
  `runFactory(...)` that `minifac run` calls. The CLI surface and the
  daemon are two consumers of the same `onEvent` stream; neither
  modifies graph-runner, factory-schema, or node-executor.

Explicitly **out of scope** (each is a future proposal when justified):

- In-browser YAML editing or factory authoring.
- Run controls beyond start (pause, resume, cancel, retry-from-node).
- Authentication, TLS, or any non-localhost exposure.
- Persistent storage of runs (beads + dolt is a separate change).
- Multi-tenant / multi-user concerns.
- Additional executors or executor configuration via the UI.
- A frontend build step, framework (React/Vue/Svelte), or asset
  bundler. The viewer is static HTML + vanilla JS.

## Capabilities

### New Capabilities

- `serve-daemon`: the `minifac serve` subcommand, the HTTP/SSE API it
  exposes, and the bundled static web viewer.

### Modified Capabilities

<!-- None. The runner, executor, factory schema, and run-cli are
     unchanged. The daemon is an additive consumer of the existing
     runner. -->

## Impact

- **New source under `src/serve/`.** A small HTTP server using
  `node:http`, an SSE writer, a run registry, factory discovery via
  `fs.watch`, and bundled static assets (HTML/JS/CSS) served from
  `src/serve/web/`.
- **New CLI subcommand wired in `src/cli.ts`.** Reuses the same
  `loadFactory` and `runFactory` paths as `minifac run`.
- **`package.json`:** no new runtime dependencies required for the
  server (the standard library covers HTTP, SSE, file watching, and
  static file serving). Frontend has no dependencies — vanilla JS.
- **Localhost-only by default.** The server binds `127.0.0.1`. A future
  change can add a flag for wider binding once auth exists; today there
  is no auth, so widening is forbidden.
- **No changes to the factory schema or runner.** This is purely an
  additive entry point on top of `runFactory`.
- **Run history is ephemeral.** Closing the daemon loses run history.
  Persistent storage (beads + dolt) is the next change; this one
  deliberately doesn't depend on it.
