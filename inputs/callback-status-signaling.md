---
change: callback-status-signaling
factory: sdd
base_branch: main
---

## Background

The [[Sentinel]] is one-way and only at the end of a node's run. To
unlock mid-run human-in-the-loop interaction, structured per-node
metadata, and the studio's chat-with-a-node surface, the [[Executor]]
needs a *bidirectional* transport. The binding decision is captured
at `docs/decisions/0017-Callback-Status-Signaling.md`; read it first.

This is opt-in and backwards compatible — every existing factory
keeps working with sentinel as the default contract.

## What to do

Implement what 0017 describes. Concretely:

### 1. New per-node `with:` knob: `callback: bool`

- Default `false`. When `true`, the runner stands up the callback
  endpoint for that node and passes connection info via env vars to
  the spawned process.
- `src/factory/schema.ts` updated: the claude executor's `WithSchema`
  gains the `callback` field.

### 2. Ephemeral localhost HTTP surface

- New module (probably `src/runner/callback.ts`) that, when a
  callback-enabled node is scheduled, allocates a random localhost
  port and a random 256-bit auth token, mounts the four endpoints
  (see below), and tears them down on node termination + small
  grace window.
- When the runner is embedded in the daemon (`minifac serve`),
  callbacks register routes on the daemon's existing HTTP server
  instead of spawning their own. The daemon's existing route table
  gains a `/run/<run-id>/node/<node-id>/<iteration>/*` namespace.
- Binding: 127.0.0.1 only. Auth: bearer token in the
  `Authorization: Bearer <token>` header. Missing or mismatched
  token returns 401.

### 3. Endpoint surface

Exact JSON shapes go in the spec; sketch here:

**`POST /status`**
- Request: `{ status: "succeeded" | "failed", reason?: string, meta?: object }`
- Response: 204 No Content (first call), 409 Conflict (subsequent calls)
- Semantics: when called, this wins over sentinel + exit code as the
  node's terminal status. `meta` is stored in [[Runs-DB]] for the
  node execution.

**`POST /question`**
- Request: `{ prompt: string, choices?: string[], timeout_ms?: number }`
- Response: `{ answer: string }` (blocks until user answers or
  timeout); on timeout, 504 Gateway Timeout
- Semantics: surfaces the question to the active human consumer (TTY
  prompt for `minifac run`, chat UI for daemon viewer). Multiple
  consumers see the same question; first answer wins.

**`POST /event`**
- Request: `{ kind: "stdout" | "stderr", line: string }` (the same
  shape as `NodeEvent` minus `status`)
- Response: 204
- Semantics: emit an event into the run's stream as if the executor
  had emitted it. Useful for non-claude executors and for nodes that
  want structured progress without going through stream-json.

**`GET /context`**
- Response: `{ priorResults: NodeResult[], factory: <name>,
  pending_human_messages: Array<{ id, content, posted_at }> }`
- Semantics: lets the node poll for human-injected messages
  ("hey, also do X"). The viewer's "chat with this node" surface
  posts to a sibling endpoint; this is how the node sees those
  messages.

**`POST /human-message`** (used by the viewer / CLI, not the
spawned process, but exposed on the same surface)
- Request: `{ content: string }`
- Response: 204
- Semantics: queues a human message that the next `GET /context`
  call will deliver.

### 4. Prompt instructions for callback-enabled claude nodes

- When `callback: true`, the runner appends a new instruction block
  (analogous to the sentinel-injection from
  [[0007-Sentinel-Runner-Injects]]) teaching the model:
  - the URL + auth token are in `MINIFAC_CALLBACK_URL` and
    `MINIFAC_CALLBACK_TOKEN`
  - how to invoke each endpoint (via Bash `curl`, with worked examples)
  - when to call `/status` (mandatory before exit), `/question`
    (when blocked on user input), `/event` (for structured progress),
    `/context` (to check for human messages mid-run)
- The injected block is in `src/executor/claude.ts` alongside
  `SENTINEL_INSTRUCTIONS` and adjacent to the existing wire-format
  comment.

### 5. Sentinel fallback semantics

- When `callback: true` and the node POSTs `/status` before exit,
  sentinel parsing is skipped for that node.
- When `callback: true` and the node does NOT POST `/status` before
  exit (process exits, child dies, etc.), the runner falls back to
  the existing sentinel + exit-code semantics. This means a node
  that fails to invoke the callback still has a well-defined outcome.
- The fallback chain is documented in `docs/concepts/Sentinel.md`.

### 6. Runs-DB schema additions

- `node_executions` table gains a `meta` column (TEXT, JSON-encoded).
  When `/status` carries `meta`, that JSON is stored here.
- A new `human_messages` table: `run_id`, `node_id`, `iteration`,
  `posted_at`, `content`, `delivered_at` (null until polled by
  `/context`).
- Schema migration ships as part of this change.

### 7. CLI: question surfacing in `minifac run`

- When a callback-enabled node POSTs `/question` during a `minifac
  run` (one-shot) invocation, the CLI surfaces the question to the
  TTY: print the prompt, read a line from stdin (or display
  numbered choices if `choices` was provided), POST the answer back.
- If stdin isn't a TTY (e.g., autorun is running this), the
  `/question` request times out per the requested `timeout_ms`
  (default 5 minutes) and the node should handle the failure
  gracefully.

### 8. Daemon: question surfacing in the viewer

- Add a small "ask" affordance in the viewer when a run has a
  pending question. The viewer POSTs the answer to `/question`'s
  response endpoint.
- This is the smallest visible studio-precursor feature; keep the
  UX simple (text input + submit), and document it in
  `docs/concepts/Run.md`.

### 9. Tests

- Unit tests for `callback.ts`: port allocation, token auth,
  endpoint behavior, cleanup on termination.
- Integration tests with a fake claude executor that POSTs to the
  endpoints (use a stub server-side surface that records what was
  posted).
- A test that exercises sentinel-fallback: `callback: true` but the
  node never POSTs `/status` — sentinel wins.
- A test that exercises sentinel-skip: `callback: true` and node
  POSTs `/status` — sentinel is ignored even if present in
  stream-json output.
- All existing tests still pass.

### 10. Specs

- `node-executor`: MODIFIED requirement to include the callback
  knob, the four endpoints, and the fallback semantics. Scenarios
  for each endpoint, for the auth failure case, and for the
  sentinel-fallback case.
- `run-cli`: MODIFIED requirement for the question surfacing on
  one-shot runs.
- `serve-daemon`: MODIFIED requirement for the question surfacing
  in the viewer (and the route registration when daemon-embedded).
- NEW capability `node-callback` (or fold into `node-executor` —
  your judgment) consolidating the endpoint surface as a single
  testable contract.

### 11. Documentation

- Update `docs/concepts/Executor.md` to describe the callback
  knob.
- Update `docs/concepts/Sentinel.md` to add the fallback chain and
  point at this decision.
- Update `docs/Open-Questions.md`: remove the "Hook-enforced
  sentinel" entry (this change supersedes that approach — the
  callback is a stronger version of the same idea) and the
  "Callback / MCP status transport" entry.
- A small section in the README pointing at the callback feature
  and when to use it.

## Out of scope

- **MCP transport.** This decision deliberately ships HTTP first;
  MCP can wrap the same endpoint surface in a future change once
  it earns its way in.
- **Always-on callback (deprecating sentinel).** Opt-in only.
  Migration to default-on is a future change.
- **Push notifications to the spawned process.** The node polls
  `/context`; the runner does NOT push to its stdin.
- **Persistent per-node sessions across runs.** Each run gets its
  own ephemeral surface. Resuming a paused run later is a future
  concern.
- **Authentication beyond per-run token.** Single-user, localhost.
  Multi-user or non-localhost exposure is a separate proposal.

## Acceptance criteria

- A node with `callback: true` in its `with:` block triggers
  endpoint allocation; the endpoint is reachable on 127.0.0.1
- The spawned process can `POST /status` and that wins over sentinel
- `POST /question` blocks until the user answers (via CLI prompt or
  viewer chat); answer is returned to the spawned process
- `POST /event` injects an event into the run's stream the same way
  the executor would
- `GET /context` returns `priorResults` and pending human messages
- Sentinel-fallback works: a callback-enabled node that doesn't POST
  `/status` still has a well-defined outcome via sentinel + exit code
- All existing tests still pass; new tests cover the endpoint surface
- `docs/Open-Questions.md` no longer has either of the deferred
  status-signaling entries
