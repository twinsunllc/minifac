## MODIFIED Requirements

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
