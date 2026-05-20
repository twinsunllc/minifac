## MODIFIED Requirements

### Requirement: Executor interface

A node executor SHALL expose a stable identifier (its `type`, matching
the `executor` field in a node definition) and a `run(node, ctx)` method
that returns an async iterable of node events. Event kinds SHALL be
limited to `stdout`, `stderr`, and `status`. A `status` event of
`succeeded` or `failed` SHALL be the final event yielded for any given
node execution. The `ctx` argument SHALL include the run-wide
`priorResults` array (see graph-runner spec), the current node's
iteration count, and the resolved `cwd` for this node (factory-relative
paths resolved to absolute).

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

### Requirement: Claude executor uses stream-json for both input and output

The `claude` executor SHALL spawn the `claude` CLI as a child process
with `--input-format stream-json` and `--output-format stream-json`. It
SHALL serialize the node's `prompt` (from `with:`) together with the
`priorResults` array from `ctx` as stream-json input on the child's
stdin. It SHALL parse the CLI's stream-json output line-by-line,
yielding each line as an `stdout` event with the raw JSON line as its
content. stderr from the CLI SHALL be forwarded as `stderr` events. It
SHALL respect the node's resolved `cwd` if provided.

The executor's terminal status SHALL be derived in the following
precedence order:

1. If the final stream-json `result` event's `result` field contains a
   sentinel matching `MINIFAC_STATUS:` followed by `succeeded` or
   `failed` (see the "Status signaling via sentinel marker" requirement),
   the sentinel determines the terminal status — overriding the CLI's
   exit code.
2. Otherwise, the child exit code determines the status: code `0`
   yields `succeeded`; any non-zero code yields `failed`. This
   preserves backwards-compatible behavior for prompts that do not opt
   into the sentinel.

In all cases, the `meta` field of the terminal status event SHALL carry
the raw child exit code under the key `exitCode` so debugging is
unambiguous when sentinel and exit code disagree.

#### Scenario: Prior results are sent on stdin as stream-json

- **WHEN** a `claude` node runs with a non-empty `ctx.priorResults`
- **THEN** the executor writes a single stream-json user-message line
  to the child stdin whose `message.content` is the JSON-serialized
  `priorResults` array followed by `\n\n---\n\n` and then the node's
  prompt, then closes stdin

#### Scenario: Empty prior results still framed as JSON array

- **WHEN** a `claude` node runs as the first node of a run (so
  `ctx.priorResults` is `[]`)
- **THEN** the user-message content sent to stdin starts with the
  literal `[]\n\n---\n\n` preamble before the prompt

#### Scenario: Prior-results JSON keys match the NodeResult shape

- **WHEN** the executor serializes a `priorResults` entry into the
  stdin preamble
- **THEN** the serialized object contains exactly the keys `nodeId`,
  `iteration`, `status`, `reason`, `startedAt`, `endedAt` with the
  values the runner provided in `ctx.priorResults`

#### Scenario: Streaming output appears event-by-event

- **WHEN** the `claude` CLI emits five stream-json messages during a run
- **THEN** the executor yields five distinct `stdout` events in order,
  one per message, as those messages arrive

#### Scenario: Non-zero exit yields failed status when no sentinel is present

- **WHEN** the `claude` CLI exits with code 1 and the final `result`
  event contains no `MINIFAC_STATUS:` marker
- **THEN** the executor's final event is `{ kind: "status",
  status: "failed", meta: { exitCode: 1, ... } }`

#### Scenario: Zero exit yields succeeded status when no sentinel is present

- **WHEN** the `claude` CLI exits with code 0 and the final `result`
  event contains no `MINIFAC_STATUS:` marker
- **THEN** the executor's final event is `{ kind: "status",
  status: "succeeded", meta: { exitCode: 0 } }`

#### Scenario: Missing CLI is reported clearly

- **WHEN** the `claude` binary is not on `$PATH`
- **THEN** the executor yields `{ kind: "status", status: "failed" }`
  with a message naming `claude` as the missing dependency

#### Scenario: Resolved cwd is honored

- **WHEN** a node declares `cwd: ./target-repo` in a factory at
  `/tmp/factories/foo.yaml`
- **THEN** the child `claude` process is spawned with cwd
  `/tmp/factories/target-repo`
