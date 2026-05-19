## ADDED Requirements

### Requirement: Executor interface

A node executor SHALL expose a stable identifier (its `type`, matching
the `executor` field in a node definition) and a `run(node, ctx)` method
that returns an async iterable of node events. Event kinds SHALL be
limited to `stdout`, `stderr`, and `status`. A `status` event of
`succeeded` or `failed` SHALL be the final event yielded for any given
node execution. The `ctx` argument SHALL include the run-wide history
(see graph-runner spec), the current node's iteration count, and the
resolved `cwd` for this node (factory-relative paths resolved to
absolute).

#### Scenario: Executor identifier matches node executor field

- **WHEN** a node declares `executor: claude`
- **THEN** the runner selects an executor whose `type` is `claude`; if no
  such executor is registered, the run fails before any node executes

#### Scenario: Final event is a terminal status

- **WHEN** an executor finishes running a node successfully
- **THEN** the last event it yields is `{ kind: "status",
  status: "succeeded" }`

#### Scenario: Failed execution yields failed status

- **WHEN** an executor encounters an unrecoverable error mid-run
- **THEN** it yields a final `{ kind: "status", status: "failed" }` event
  (after any partial `stdout`/`stderr` already emitted) and stops

### Requirement: Executor validates its own `with:` payload

Each executor SHALL validate the `with:` object passed to it and reject
unknown or malformed inputs before producing any output. Validation
errors SHALL be reported as a `failed` status event with a clear message.

#### Scenario: Claude executor rejects missing prompt

- **WHEN** a node with `executor: claude` has no `prompt` in `with:`
- **THEN** the executor yields `{ kind: "status", status: "failed",
  meta: <validation error> }` and produces no `stdout`

### Requirement: Claude executor uses stream-json for both input and output

The `claude` executor SHALL spawn the `claude` CLI as a child process
with `--input-format stream-json` and `--output-format stream-json`. It
SHALL serialize the node's `prompt` (from `with:`) together with the run
history from `ctx` as stream-json input on the child's stdin. It SHALL
parse the CLI's stream-json output line-by-line, yielding each line as
an `stdout` event with the raw JSON line as its content. stderr from
the CLI SHALL be forwarded as `stderr` events. It SHALL respect the
node's resolved `cwd` if provided. On a non-zero exit, the executor
SHALL yield a `failed` status; on zero exit, a `succeeded` status.

#### Scenario: Run history is sent on stdin as stream-json

- **WHEN** a `claude` node runs with a non-empty `ctx.history`
- **THEN** the executor writes a stream-json document to the child
  stdin that encodes the prior events (in order) plus the node's
  prompt, then closes stdin

#### Scenario: Streaming output appears event-by-event

- **WHEN** the `claude` CLI emits five stream-json messages during a run
- **THEN** the executor yields five distinct `stdout` events in order,
  one per message, as those messages arrive

#### Scenario: Non-zero exit yields failed status

- **WHEN** the `claude` CLI exits with code 1
- **THEN** the executor's final event is `{ kind: "status",
  status: "failed", meta: { exitCode: 1, ... } }`

#### Scenario: Missing CLI is reported clearly

- **WHEN** the `claude` binary is not on `$PATH`
- **THEN** the executor yields `{ kind: "status", status: "failed" }`
  with a message naming `claude` as the missing dependency

#### Scenario: Resolved cwd is honored

- **WHEN** a node declares `cwd: ./target-repo` in a factory at
  `/tmp/factories/foo.yaml`
- **THEN** the child `claude` process is spawned with cwd
  `/tmp/factories/target-repo`

### Requirement: Executor registry

The runner SHALL maintain a registry of executors keyed by `type`. The
core registry SHALL ship with exactly one executor (`claude`) in v0.
Registering a second executor with the same `type` SHALL fail at
registration time.

#### Scenario: Duplicate registration fails

- **WHEN** code attempts to register two executors both reporting
  `type: "claude"`
- **THEN** registration throws before any factory is loaded
