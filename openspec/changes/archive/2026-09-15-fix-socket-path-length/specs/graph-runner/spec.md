## MODIFIED Requirements

### Requirement: Per-run MCP server lifecycle

The runner SHALL start exactly one inline MCP server per run,
listening on a unix socket in a fresh per-run directory under the
operating system's temporary directory (`os.tmpdir()`, which honors
`$TMPDIR`) at `<tmpdir>/minifac-<run-id-prefix>-XXXXXX/mcp.sock`,
where `<run-id-prefix>` is the first 8 characters of the run id
minted at run start (per the existing "Per-node-per-iteration
outputs directory" requirement, including the UUID-shaped fallback
when no store is in scope) and `XXXXXX` is the unique suffix chosen
by `mkdtemp`. The socket path SHALL NOT depend on `MINIFAC_HOME`:
`sun_path` is limited to 104 bytes on macOS/BSD and 108 on Linux,
and a path under a deep `MINIFAC_HOME` overflows it.

Before creating the directory, the runner SHALL check the socket
path's byte length against the platform limit. If it exceeds the
limit the runner SHALL NOT create the directory and SHALL fail the
server start with an error naming the path, its byte length, the
limit, and `TMPDIR` as the remedy.

When the server fails to start for any reason, the runner SHALL
continue the run on the filesystem-JSON transport and SHALL report
the fallback loudly: one line naming the cause and stating that the
`mcp__minifac__report_*` tools will be absent for this run, written
to process stderr, emitted as a `stderr` event on the run's event
stream (node id `__mcp__`), and appended to the run's event log in
the store when a store is in scope.

The server SHALL be started in `runFactory` setup, before any
node is dispatched, and SHALL be stopped at run termination
(success or failure) in the same lifecycle block that closes
the run's store. Stopping the server SHALL close the socket and
remove the socket file and its per-run directory from disk.

The server SHALL be implemented using the official MCP
TypeScript SDK (`@modelcontextprotocol/sdk`). Hand-rolling the
JSON-RPC framing is out of scope. The SDK version SHALL be
locked in `package.json` and SHALL be subject to the existing
dep-freshness CI gate.

#### Scenario: Server starts before any node dispatch

- **WHEN** `runFactory` is invoked for a factory whose first
  node is `propose`
- **THEN** the MCP socket at
  `<tmpdir>/minifac-<run-id-prefix>-XXXXXX/mcp.sock` exists and is
  accepting connections before `propose` is dispatched

#### Scenario: Socket path is independent of MINIFAC_HOME

- **WHEN** `MINIFAC_HOME` is a directory deep enough that
  `${MINIFAC_HOME}/outputs/<run-id>.mcp.sock` would exceed the
  platform `sun_path` limit
- **THEN** the MCP server still starts, its socket is under
  `os.tmpdir()`, and the `mcp__minifac__report_*` tools are
  available to every MCP-capable dispatch in the run

#### Scenario: Socket path over the limit fails loudly and falls back

- **WHEN** `TMPDIR` is a directory deep enough that even
  `<tmpdir>/minifac-<run-id-prefix>-XXXXXX/mcp.sock` exceeds the
  platform `sun_path` limit
- **THEN** no per-run directory is created; the run proceeds on the
  filesystem-JSON transport; process stderr and the run's event
  stream (node id `__mcp__`) each carry a line naming the path, its
  byte length, the limit, `TMPDIR`, and that the
  `mcp__minifac__report_*` tools will be absent for this run

#### Scenario: Fallback is recorded in the run log

- **WHEN** the MCP server fails to start and a store is in scope
- **THEN** the same `stderr` line is appended to the run's events in
  the store, so `minifac runs` shows it after the fact

#### Scenario: Server stops on successful run termination

- **WHEN** a run completes successfully (all nodes terminate
  with `succeeded`, the runner exits its scheduling loop, and
  the store is closed)
- **THEN** the MCP socket is closed and the socket file and its
  per-run directory are removed from disk before `runFactory`
  returns

#### Scenario: Server stops on failed run termination

- **WHEN** a run terminates because a node failed and the
  factory has no recovery edge from the failed node
- **THEN** the MCP socket is closed and the socket file and its
  per-run directory are removed from disk before `runFactory`
  returns the failed result

#### Scenario: Server stops on uncaught exception

- **WHEN** an exception is thrown mid-run (e.g. the store
  rejects an insert)
- **THEN** the runner's `finally` block closes the MCP socket
  and removes the socket file and its per-run directory even
  though `runFactory` is rethrowing the exception

#### Scenario: Concurrent runs use distinct sockets

- **WHEN** two runs with distinct run ids `aaa...` and `bbb...`
  execute concurrently in the same process
- **THEN** each run binds a distinct socket file in its own
  `mkdtemp` directory; tool calls from one run never reach the
  other run's server
