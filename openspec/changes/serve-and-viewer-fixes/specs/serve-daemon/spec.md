## MODIFIED Requirements

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
