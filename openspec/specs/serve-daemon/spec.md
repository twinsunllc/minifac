# serve-daemon Specification

## Purpose
TBD - created by archiving change serve-and-viewer. Update Purpose after archive.
## Requirements
### Requirement: `minifac serve` command

The CLI SHALL expose a `serve` subcommand that starts a long-running
local daemon. The command SHALL accept:

- an optional positional argument naming the directory to watch
  (default: the current working directory),
- `--port <number>` (default `4280`),
- `--host <string>` (default `127.0.0.1`).

The daemon SHALL bind only to a loopback address. If `--host` is not a
loopback address (e.g. not `127.0.0.1`, not `::1`, not `localhost`),
the daemon SHALL refuse to start and exit non-zero with an error
message naming the rejected host. The daemon SHALL run until it
receives SIGINT or SIGTERM. On signal, the daemon SHALL:

1. stop accepting new HTTP connections,
2. **actively terminate** any in-flight SSE responses by calling each
   live `SseWriter`'s close path (writing `res.end()` against the
   underlying response), rather than waiting for the client to
   disconnect, and
3. exit `0` once all sockets are closed.

Closing the daemon SHALL NOT block on long-lived SSE subscribers; the
daemon SHALL end those responses itself so that `server.close()` can
resolve promptly.

#### Scenario: Default invocation starts on 127.0.0.1:4280

- **WHEN** the user invokes `minifac serve` in a directory containing
  one or more `*.yaml` factories
- **THEN** the daemon binds `127.0.0.1:4280`, prints a single line to
  stderr naming the bound host:port, and stays running until signaled

#### Scenario: Non-loopback host is rejected

- **WHEN** the user invokes `minifac serve --host 0.0.0.0`
- **THEN** the daemon does NOT bind any port, writes an error to
  stderr naming the rejected host, and exits with a non-zero code

#### Scenario: SIGINT shuts the daemon down cleanly

- **WHEN** the daemon is running and receives SIGINT
- **THEN** the daemon stops accepting new HTTP connections, actively
  ends every in-flight SSE response, and exits `0` without waiting
  for SSE clients to disconnect

#### Scenario: Shutdown ends an active SSE subscriber

- **WHEN** a client is currently subscribed to `GET /api/runs/:id/events`
  for a run that is still `running`, and the daemon receives SIGINT (or
  the in-process `DaemonHandle.close()` is invoked)
- **THEN** the subscriber's SSE response stream ends within a small
  bounded time and the daemon process exits `0`; the daemon does not
  hang waiting for the subscriber to disconnect on its own

### Requirement: Factory discovery via directory watch

The daemon SHALL discover factory YAML files by reading the watched
directory at startup and then watching for filesystem changes. Files
whose names end in `.yaml` or `.yml` (case-insensitive) SHALL be
considered. For each candidate file the daemon SHALL run the existing
factory loader; the resulting entry SHALL be exposed via the
factories API whether the load succeeded or failed, so a broken
factory is visible alongside its error.

The factory id used in API responses SHALL be the file's basename
without extension. Two files producing the same basename in the same
directory is a user error; the daemon MAY pick either deterministically
and SHALL surface a warning on stderr but SHALL NOT crash.

#### Scenario: Initial scan picks up existing factories

- **WHEN** the daemon starts in a directory containing `hello.yaml`
  and `sdd.yaml`
- **THEN** `GET /api/factories` returns a list whose ids include
  `hello` and `sdd`

#### Scenario: Invalid factory is listed with its load error

- **WHEN** the watched directory contains `broken.yaml` whose contents
  fail schema validation
- **THEN** `GET /api/factories` lists `broken` with a non-null
  `error` field whose message describes the validation failure

#### Scenario: New file appears after startup

- **WHEN** the daemon is running and the user writes a new
  `another.yaml` into the watched directory
- **THEN** within a short delay, `GET /api/factories` includes
  `another` in its response (an immediately-subsequent request is
  acceptable if the underlying `fs.watch` event has arrived)

### Requirement: HTTP API surface

The daemon SHALL expose the following HTTP endpoints. Request and
response bodies SHALL be JSON (`Content-Type: application/json`)
unless otherwise stated. All paths SHALL be served under the prefix
`/api/`.

- `GET /api/factories` — list discovered factories. Response shape:
  `{ factories: Array<{ id, path, name?, error? }> }`. `name` is the
  factory's declared `name` field when load succeeded; `error` is a
  string when load failed.
- `GET /api/factories/:id` — fetch one factory's parsed shape:
  `{ id, path, name, nodes, edges }` on success; `404` if not
  discovered; `422` if discovered but failed to load (body carries
  the error).
- `GET /api/runs` — list runs, sorted by `startedAt` descending.
  Response shape:
  `{ runs: Array<{ id, factoryId, status, startedAt, endedAt? }> }`.
  Optional query parameters: `factory` (filter by `factoryId`),
  `change` (filter by brief change name), `status` (one of
  `running` | `succeeded` | `failed`), `limit` (positive integer,
  default `50`, hard ceiling enforced by the daemon). Unknown
  query parameters SHALL be ignored. An invalid `limit` (non-
  positive, non-numeric, or above the ceiling) SHALL produce
  `400` with a JSON body naming the offending parameter.
- `GET /api/runs/:id` — fetch one run's metadata and accumulated
  event history: `{ id, factoryId, status, startedAt, endedAt?, result?, events: Array<...> }`.
  Each event entry carries the same shape the runner emits via
  `onEvent` plus a monotonically increasing per-run `index`. The
  events SHALL be read from the store, so prior runs from prior
  daemon processes return their full persisted log.
- `POST /api/runs` — start a new run. Request body:
  `{ factoryId: string, cwd?: string }`. Response on success:
  `201 Created` with `{ id, factoryId, status: "running", startedAt }`.
  Response on conflict: `409 Conflict` with
  `{ error: "run_in_flight", activeRunId }` when a run for the named
  factory is already `running`. Response on unknown factory: `404`.
  Response on invalid `cwd`: `400` with a message naming the
  rejected path.
- `GET /api/runs/:id/events` — Server-Sent Events stream (see the
  "SSE event stream" requirement).
- `GET /` (and any other unmatched non-`/api` path) — static viewer
  assets (see the "Static viewer assets" requirement).

The router SHALL respond with `405 Method Not Allowed` for known
paths invoked with a wrong method, and `404 Not Found` for unknown
paths under `/api/`.

#### Scenario: List factories returns discovered set

- **WHEN** the daemon has discovered `hello.yaml` (valid) and
  `broken.yaml` (invalid)
- **THEN** `GET /api/factories` returns HTTP 200 with a body whose
  `factories` array contains entries for both, with `broken`'s entry
  carrying a non-null `error`

#### Scenario: Starting a run returns 201 and a run id

- **WHEN** the client POSTs `{ factoryId: "hello" }` to `/api/runs`
  and `hello` is a valid factory with no run currently in flight
- **THEN** the response is HTTP 201 with a body containing a
  non-empty `id` and `status: "running"`

#### Scenario: Second concurrent run for the same factory is rejected

- **WHEN** a run for factory `hello` is already `running` and the
  client POSTs another `{ factoryId: "hello" }` to `/api/runs`
- **THEN** the response is HTTP 409 with a body whose `error` is
  `"run_in_flight"` and whose `activeRunId` matches the first run

#### Scenario: Run for unknown factory is rejected

- **WHEN** the client POSTs `{ factoryId: "does-not-exist" }` to
  `/api/runs`
- **THEN** the response is HTTP 404

#### Scenario: Unknown method on known path returns 405

- **WHEN** the client invokes `PUT /api/factories`
- **THEN** the response is HTTP 405

#### Scenario: List runs filters by factory

- **WHEN** the daemon has runs spanning factories `hello` and
  `sdd`, and the client invokes `GET /api/runs?factory=sdd`
- **THEN** the response is HTTP 200 with a `runs` array containing
  only the `sdd` runs, in `startedAt`-descending order

#### Scenario: List runs filters by status and change

- **WHEN** the client invokes
  `GET /api/runs?status=failed&change=my-change`
- **THEN** the response is HTTP 200 with a `runs` array containing
  only runs whose persisted `status` is `failed` and whose
  `change` is `my-change`

#### Scenario: List runs honors limit

- **WHEN** the store contains 100 runs and the client invokes
  `GET /api/runs?limit=5`
- **THEN** the response is HTTP 200 with at most 5 runs, the 5
  with the most recent `startedAt`

#### Scenario: Invalid limit is rejected

- **WHEN** the client invokes `GET /api/runs?limit=-1` (or
  `limit=abc`)
- **THEN** the response is HTTP 400 with a JSON body naming the
  offending parameter; no runs are returned

#### Scenario: Run from a prior daemon process is fetchable by id

- **WHEN** a run completed under a previous daemon process and
  the daemon has since restarted, and the client invokes
  `GET /api/runs/<that-id>`
- **THEN** the response is HTTP 200 with the run's metadata and
  its full persisted event log

### Requirement: SSE event stream

The endpoint `GET /api/runs/:id/events` SHALL respond with
`Content-Type: text/event-stream` and SHALL stream the run's events as
SSE frames. Each frame SHALL:

- carry a numeric `id:` matching the event's per-run monotonic index,
- carry an `event:` name equal to the event kind (`stdout`, `stderr`,
  `status`),
- carry a `data:` payload containing the JSON-encoded event entry
  (including `nodeId`, `iteration`, and kind-specific payload).

When the connection opens, the server SHALL replay any buffered prior
events the client has not yet seen, then keep the connection open and
push new events as the runner emits them. The client MAY include a
`Last-Event-ID` request header (set by the browser `EventSource` on
auto-reconnect); when present and well-formed, the server SHALL replay
only events with index strictly greater than that value.

`Last-Event-ID` SHALL be considered well-formed when it is a string
representing a non-negative decimal integer (e.g. `0`, `5`, `42`). A
present-but-malformed `Last-Event-ID` (e.g. `abc`, `1.5`, `-1`, an
empty string, `NaN`) SHALL cause the server to respond with HTTP `400`
and a JSON body of `{ error: "invalid_last_event_id", message: <string> }`
and SHALL NOT upgrade the response to `text/event-stream`. An *absent*
`Last-Event-ID` SHALL behave as a fresh subscription (replay the full
buffer, then live tail).

When the run ends, the server SHALL push a final frame with `event:`
equal to `run_end` whose `data:` payload contains the run's
terminal status and result reason, then close the connection.

If the requested run id does not exist, the endpoint SHALL respond
`404` and not upgrade to SSE.

#### Scenario: Client receives events as they arrive

- **WHEN** a client opens an SSE stream against a freshly started run
  and the runner subsequently emits three `stdout` events
- **THEN** the client receives three SSE frames, in order, each with
  an `event:` of `stdout` and a `data:` payload containing the
  emitted line and the emitting node id

#### Scenario: Mid-run connection replays buffered events first

- **WHEN** a run has already emitted ten events and a new client
  opens the SSE stream without a `Last-Event-ID`
- **THEN** the client receives all ten buffered events (in order,
  with their original indices) before any new events

#### Scenario: Reconnect resumes from Last-Event-ID

- **WHEN** a client reconnects to a run's SSE stream and sends
  `Last-Event-ID: 5`
- **THEN** the client receives only events with index `> 5`,
  followed by any new events as they arrive

#### Scenario: Reconnect with Last-Event-ID 0 skips event 0

- **WHEN** a client opens an SSE stream and sends `Last-Event-ID: 0`
- **THEN** the client receives only events with index `> 0`; the
  event at index `0` is NOT replayed

#### Scenario: Malformed Last-Event-ID is rejected with 400

- **WHEN** a client opens an SSE request to `GET /api/runs/:id/events`
  with `Last-Event-ID: not-a-number` (or any value that is not a
  non-negative decimal integer)
- **THEN** the server responds HTTP `400` with a JSON body whose
  `error` is `"invalid_last_event_id"`, does NOT set `Content-Type:
  text/event-stream`, and does NOT subscribe the client to the run

#### Scenario: Terminal frame closes the stream

- **WHEN** the run ends successfully
- **THEN** the client receives a final frame whose `event:` is
  `run_end` and whose `data:` payload reports
  `{ status: "succeeded", ... }`, after which the server closes the
  connection

#### Scenario: SSE request for unknown run returns 404

- **WHEN** the client requests `GET /api/runs/does-not-exist/events`
- **THEN** the server responds HTTP 404 without upgrading to SSE

### Requirement: Run registry semantics

The daemon SHALL maintain a run registry backed by the
`run-storage` capability's `RunStore`. Each run SHALL have a
server-generated string id, a `factoryId`, a `status` (one of
`pending`, `running`, `succeeded`, `failed`), a `startedAt`
timestamp, an `endedAt` timestamp on completion, an append-only
event log with per-run monotonic indices, and (on completion) the
structured runner result.

The registry SHALL hold at most one run with `status: "running"`
for any given `factoryId` at a time. Completed runs SHALL remain
in the registry until removed by an explicit retention pass (none
exists in v0; the registry just keeps reading from the store).
The daemon MAY choose any consistent ordering when listing runs,
but the default SHALL be `startedAt` descending so the most
recent runs surface first.

The registry SHALL persist across daemon restarts via the store.
On startup the daemon SHALL read prior runs from the store so
they are visible immediately. Any run the store reports as
`running` at startup time (left over from a previous process
that exited without finalization) SHALL be marked `failed` with
`reason: "daemon_restart"` in the store, and SHALL be exposed in
the registry with that terminal status; the daemon SHALL NOT
attempt to resume such a run.

The registry SHALL keep an in-memory subscriber set for live SSE
fan-out, but durable state (run rows, event rows, node-execution
rows) SHALL be served from the store.

#### Scenario: Run lifecycle moves through expected statuses

- **WHEN** a run is created and the runner subsequently completes
  successfully
- **THEN** the run's status moves `pending` → `running` →
  `succeeded`, `endedAt` is set when the runner returns, and the
  same lifecycle is reflected in the underlying store

#### Scenario: Concurrent runs for distinct factories are allowed

- **WHEN** a run for factory `hello` is `running` and the client
  POSTs `{ factoryId: "sdd" }` to `/api/runs`
- **THEN** the second POST succeeds (HTTP 201) and both runs are
  visible in `GET /api/runs`

#### Scenario: Daemon restart preserves prior runs

- **WHEN** the daemon is shut down after several runs completed
  and is then restarted against the same `runs.db`
- **THEN** `GET /api/runs` returns the prior runs (sorted newest
  first), each with its terminal status and `endedAt` intact;
  fetching `GET /api/runs/:id` for any prior run returns its
  full persisted event log

#### Scenario: Orphaned `running` rows from a prior daemon are marked failed

- **WHEN** the daemon starts and the store contains a run whose
  `status` is `running` (because a previous daemon process died
  before finalization)
- **THEN** the daemon updates that run to `status: "failed"`,
  `reason: "daemon_restart"`, and an `endedAt` timestamp of the
  current daemon startup; `GET /api/runs/:id` reflects the
  failure and the daemon does not attempt to resume the run

### Requirement: Static viewer assets

The daemon SHALL serve a single-page viewer at `GET /`. The viewer
SHALL be plain HTML loading vanilla JavaScript modules and CSS; it
SHALL NOT require a build step, transpiler, or framework runtime
fetched from the network. All assets the viewer needs SHALL be
served from the daemon itself (no remote CDN dependencies).

The static handler SHALL guard against path traversal: requested
paths SHALL be resolved against the static root, and any resolved
path outside that root SHALL produce `403 Forbidden`. Requests for
paths not present on disk SHALL produce `404 Not Found`.

The viewer's behavior SHALL include at minimum:

- a list of factories discovered by the daemon, fetched from
  `GET /api/factories`,
- a graph render for the selected factory showing nodes and edges,
  with each node visually indicating its current status when a run
  is active,
- a control to start a run for the selected factory (POSTing to
  `/api/runs`),
- a live event tail subscribed via `EventSource` to
  `/api/runs/:id/events`, showing each event's node id and content,
- a "Recent runs" section that lists prior runs (fetched from
  `GET /api/runs?limit=<n>`) with at minimum the factory id, the
  run status, and the `startedAt` timestamp; clicking an entry
  SHALL render that run's persisted event log in the existing
  event-tail pane without starting a new run.

The viewer SHALL NOT offer YAML editing, run controls beyond start
(no pause/resume/cancel/retry-from-node), authentication UI, or any
non-localhost endpoint configuration.

#### Scenario: Viewer is served at root

- **WHEN** a browser requests `GET /` against the daemon
- **THEN** the response is HTTP 200 with `Content-Type: text/html`
  and a body containing the viewer's HTML

#### Scenario: Path traversal is refused

- **WHEN** a client requests `GET /../../etc/passwd` or any path
  resolving outside the static root
- **THEN** the response is HTTP 403

#### Scenario: Viewer lists discovered factories

- **WHEN** the viewer loads and the daemon has discovered `hello`
  and `sdd`
- **THEN** the viewer's UI lists `hello` and `sdd` as selectable
  factories

#### Scenario: Viewer starts a run and tails its events

- **WHEN** the user picks a factory and clicks the start-run control
- **THEN** the viewer POSTs to `/api/runs`, opens an `EventSource`
  against the returned run's `/api/runs/:id/events`, and renders
  each incoming event in a live event tail

#### Scenario: Viewer shows prior runs and replays one

- **WHEN** the viewer loads against a daemon whose store carries
  several completed runs from prior daemon processes
- **THEN** the "Recent runs" section lists those runs (newest
  first); clicking one renders that run's persisted event log in
  the event-tail pane without POSTing a new run

### Requirement: Daemon shares the core runner with `minifac run`

The daemon SHALL execute factories by invoking the same
`runFactory(...)` entry point that `minifac run` invokes, with the
same executor registry construction. The daemon SHALL NOT fork the
runner, reimplement scheduling, or alter event semantics. The
daemon's `onEvent` consumer SHALL append the event to the run's
registry log and fan it out to any active SSE subscribers.

#### Scenario: A factory that succeeds under `minifac run` also succeeds under serve

- **WHEN** factory F succeeds under `minifac run F.yaml` and the
  same factory is started via `POST /api/runs` against the daemon
- **THEN** the daemon-side run reaches `status: "succeeded"` with
  the same result reason and the same event sequence (per node id
  and iteration; absolute timestamps may differ)

#### Scenario: Daemon does not re-implement node scheduling

- **WHEN** a contributor inspects `src/serve/`
- **THEN** the daemon's run-kickoff code calls `runFactory(...)`
  from the existing runner module and provides only an `onEvent`
  consumer that records and fans out events; no separate scheduling
  loop exists

### Requirement: Localhost-only security posture

The daemon SHALL NOT support authentication, TLS, or any non-loopback
binding in v0. The implementation SHALL refuse to start if `--host`
resolves to a non-loopback address (see the "`minifac serve` command"
requirement). Documentation SHALL state that the daemon is intended
for single-user local use and that exposing it on a network
interface is unsupported.

#### Scenario: No auth surface is exposed

- **WHEN** a contributor inspects the daemon's HTTP routes
- **THEN** no route accepts, requires, or processes credentials,
  cookies, or authorization headers

#### Scenario: Documentation calls out the local-only posture

- **WHEN** a user reads `README.md`'s `minifac serve` section
- **THEN** the section states the daemon binds loopback only and
  that wider exposure is unsupported in v0

