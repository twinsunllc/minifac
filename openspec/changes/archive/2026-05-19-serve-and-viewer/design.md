## Context

minifac today is a one-shot CLI: `minifac run path/to/factory.yaml`
loads, validates, executes, streams events to the terminal, exits.
The runner emits a typed event stream already — `stdout`, `stderr`,
`status` per `nodeId` and `iteration` — which `cli.ts` formats as
prefixed text lines.

A live web viewer needs the same event stream rendered differently:
the graph (so you can see which node is which), per-node status (so
you can see which node is currently running, which retried, which
failed), and a tail of events (so you can read what a node is
actually saying mid-run). Nothing about that requires changing the
runner — the runner already emits the right shape.

This change adds a daemon (`minifac serve`) that consumes that same
event stream from the runner side and exposes it on the HTTP side,
plus a tiny static viewer.

## Goals / Non-Goals

**Goals:**

- Ship a `minifac serve` subcommand that runs a local daemon on
  `127.0.0.1`.
- Expose a read-only HTTP API over the daemon: list watched
  factories, list active runs, fetch a run's accumulated history,
  stream live events for a run via SSE.
- Expose a single write endpoint: start a run for a factory.
- Ship a static web viewer that uses those endpoints to show the
  graph, statuses, and a live event tail.
- Share the core runner with `minifac run` — same `runFactory`, same
  event shape, same loader.
- Allow viewer clients connecting mid-run to receive the run's
  buffered prior events and then tail new ones without dropping
  events.

**Non-Goals:**

- Run controls beyond starting (no pause/resume/cancel/retry-from-node).
- In-browser YAML editing.
- Authentication, TLS, multi-user, or non-localhost exposure.
- Persistent run history. Closing the daemon loses runs.
- Frontend build step or framework — vanilla HTML/JS, no React.
- Any change to graph-runner, factory-schema, or node-executor.

## Decisions

### Decision: Server-Sent Events for the live event stream, not WebSocket

The runner's event stream is one-way (runner → consumer). SSE is the
native fit:

- Plain HTTP, no framing protocol, no upgrade handshake.
- Browser `EventSource` is built in; no client library required.
- Built-in reconnect with `Last-Event-ID`, which we can map to "resend
  events after this index" out of our per-run ring buffer.
- The server side is a one-line content type, a `text/event-stream`
  response with `\n\n`-separated `data:` frames; trivially
  implementable on `node:http` without a library.
- No bidirectional control surface in v0 — the only client → server
  action is "start a run," which is a discrete POST, not a streaming
  message.

WebSocket buys us bidirectional framing we do not need, plus an
upgrade handshake and binary support we do not need. The only thing
WS does better than SSE is multiplex multiple subscriptions on one
TCP connection; with one viewer tab connected to one run at a time,
that does not pay rent.

If a future change adds bidirectional controls (pause/cancel a run
from the viewer), we can revisit: either layer those as discrete
POSTs (preferred — keeps the streaming side one-way) or migrate to
WS at that point.

### Decision: `node:http` server, no Express/Fastify/Hono

The endpoint surface in v0 is tiny — five or six routes total. The
core stdlib gives us request parsing, response writing, and
`text/event-stream` directly. Adding a framework introduces a
dependency we'd have to keep current (and that other minifac
contributors would have to learn) for a payoff that's mostly
ergonomic.

A handwritten ~50-line router (method + path match + parameter
extraction) is acceptable. If the API grows past ~15 routes we
re-evaluate.

### Decision: Static viewer at `/`, vanilla JS, no build step

The viewer is one HTML file, one or two JS files, one CSS file,
loaded directly by the browser. No bundler, no transpiler, no
framework. Constraints follow:

- ES modules served as-is; modern browsers (Chrome/Firefox/Safari
  current) are the supported set.
- Graph rendering uses an inline SVG drawn from the factory's
  `nodes` and `edges` (it's a tiny graph — a handful of nodes; a
  hand-rolled layout — e.g. a topo-sort + level-by-level placement —
  is enough). No graphviz, no cytoscape, no d3.
- Event tail is a scrolling pre-formatted region rendering each SSE
  frame's text.
- State is held in a small object on the page; no Redux, no signals.

This caps the v0 viewer's complexity hard. Going beyond it (filters,
saved layouts, dark mode toggle, etc.) requires its own proposal.

### Decision: Ephemeral, in-process run registry

Each run gets a server-generated id (a short ULID-ish string from
`crypto.randomUUID()` or `randomBytes(8).toString('hex')` — either is
fine, no dependency). The registry holds:

- The original factory (parsed in-memory)
- Status (`pending` | `running` | `succeeded` | `failed`)
- The runner result (set on completion)
- An append-only event log (the same entries the runner already
  emits, with a monotonic per-run index)
- The set of SSE subscribers

When a viewer connects to the SSE stream, the server replays the
buffered events from `Last-Event-ID + 1` (or from index 0 if no
last-id), then keeps the connection open to push new events. When
the run ends, the server pushes a terminal event and closes the
stream.

When the daemon process exits, all of that goes with it. Persisting
runs across daemon restarts is the job of the upcoming beads+dolt
storage change; pretending we do it today would just be a layer to
rip out when that change lands.

### Decision: Factory discovery via directory watch, not a registry endpoint

The daemon watches the served directory (default `.`) for `*.yaml`
files, loads and validates each one when it appears or changes, and
exposes the resulting set via `GET /api/factories`. Invalid factories
are listed too, with their load error attached, so the viewer can
show "broken factory" alongside its diagnostic.

This means a user can `vim hello.yaml` in their editor and refresh
the viewer to see the updated graph without restarting the daemon.

`fs.watch` is the stdlib mechanism; it's known to be inconsistent
across platforms, but the v0 fallback is acceptable: if a file
change is missed, the user can re-pick the factory in the viewer to
force a re-read. We do not need fancy debouncing or chokidar here.

### Decision: One run per factory at a time (in v0)

The registry permits at most one *running* run per factory id at a
time. Attempts to start a second run for a factory that's still
running return `409 Conflict` with a body naming the active run id.
Completed runs stay in the registry (until daemon shutdown) and a
new run for the same factory is allowed.

This keeps the viewer's mental model simple ("the graph shows the
current run's state") without locking us out of multi-run later: a
future change can lift this restriction and the viewer can grow a
run picker.

### Decision: Run-start request body carries an optional override `cwd`

`POST /api/runs` takes `{ factory: <id>, cwd?: <abs-path> }`. If
`cwd` is omitted, per-node `cwd` resolves relative to the factory
file as it does today. If `cwd` is provided, the daemon refuses
non-absolute paths and refuses paths outside any safe root — the
constraint is that the user is explicitly trusted (localhost-only),
so we don't sandbox, but we reject path strings that don't pass
`path.isAbsolute`.

This is a small concession to the dogfood use case: running the SDD
factory against different target dirs without editing the YAML
each time. It does not introduce new schema surface (the per-node
`cwd` mechanism already exists); it just lets the run kickoff
override it.

### Decision: Static assets bundled into the published npm package

The HTML/JS/CSS lives under `src/serve/web/` in the repo and is
copied to `dist/serve/web/` by `tsc` via a small `files` list in
`tsconfig.json` or a post-build copy step. `package.json`'s `files`
key already includes `dist/`, so the assets ship with the package.
No CDN, no remote loads.

## Risks / Trade-offs

- **`fs.watch` reliability.** Known to miss events on some
  platforms / editors that write via rename-then-replace. Acceptable
  for v0: the viewer can force a re-read.
- **SSE through proxies.** Not a concern for localhost-only, but
  documenting: if someone ever ports this to run behind a proxy,
  they need to disable response buffering.
- **Hand-rolled HTTP router.** Easy to get wrong (path traversal in
  the static handler, missing method checks). Mitigated by keeping
  the route count tiny, normalizing static paths with `path.resolve`
  + an explicit root-prefix check, and writing tests against each
  route.
- **One-run-per-factory cap may be surprising.** Documenting it in
  the API response and viewer suffices; lifting it is a future
  change.
- **No auth means the daemon is dangerous if accidentally bound to a
  public interface.** Refusing any host that resolves outside
  `127.0.0.1` at startup mitigates this; we'll fail fast rather than
  silently bind `0.0.0.0`.
- **Graph layout quality.** A hand-rolled layered layout will look
  fine for ~10-node factories. It won't scale to 100-node graphs;
  when someone has a 100-node factory, we'll consider a real layout
  library.

## Open Questions

<!-- None of the user's intent constraints felt wrong; capturing for
     the record any genuinely-undecided points. -->

- The run registry retains completed runs in memory until daemon
  shutdown. There's no eviction policy. If a user leaves the
  daemon running for days and starts hundreds of runs, memory
  grows. This is acceptable for v0 (dogfood: restart the daemon
  weekly); a real eviction policy lands with the persistent
  storage change.
- The viewer renders one factory's graph at a time. Whether the
  list of factories lives in a sidebar or a dropdown is left to
  implementation; the spec binds only that the viewer can pick a
  factory and start a run for it.
