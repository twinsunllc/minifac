---
status: accepted
date: 2026-05-20
supersedes: []
superseded-by: null
tags: [decision]
---

# 0017: Callback transport for status + bidirectional node interaction

## Context

Today the spawned [[Executor]] communicates node status to the
[[Runner]] through the [[Sentinel]] — a `MINIFAC_STATUS:` line in the
model's final assistant text. That's one-way and only at the end. It
works for the current shape of the [[SDD-Loop]] but doesn't support:

- Mid-run human-in-the-loop interaction ("I forgot, also do X")
- A node asking the user a clarifying question and waiting for the
  answer
- A future studio chat surface ("why did this fail" / "what would
  have made this better") that can resume an existing run
- Structured per-node status with arbitrary metadata (richer than a
  REASON string)

The sentinel is also tamper-fragile: the model has to remember to
emit the marker, and a future model upgrade could change formatting
in ways that break parsing.

## Decision

**Add an opt-in callback transport** for the [[Executor]]. When
enabled, the runner stands up an ephemeral localhost HTTP endpoint
(or registers a route with the daemon when running in daemon mode)
and passes the URL + a random per-run auth token to the spawned
process via environment variables.

```
MINIFAC_CALLBACK_URL=http://127.0.0.1:<port>/run/<run-id>/node/<node-id>/<iteration>
MINIFAC_CALLBACK_TOKEN=<random>
```

**Endpoints exposed:**

- `POST /status` — structured status report `{ status:
  "succeeded" | "failed", reason?: string, meta?: object }`. When
  called, this wins over sentinel + exit code. May be called at most
  once per node execution (a second call is rejected).
- `POST /question` — `{ prompt: string, choices?: string[] }`.
  Returns when the human answers (via CLI prompt, viewer UI, or any
  future surface). Blocking from the client's perspective.
- `POST /event` — emit a structured event into the run's event
  stream from within the spawned process. Lets a node surface
  intermediate progress without going through the stream-json
  output (useful for nodes that aren't the claude executor).
- `GET /context` — fetch the node's `priorResults`, factory shape,
  and any pending human messages addressed to this node. The mid-run
  "hey, also do X" surface writes to this; the node polls or
  long-polls for changes.

**Enabling the transport** is a per-node `with:` flag for the
claude executor:

```yaml
with:
  callback: true   # opt in; default false
```

When `callback: false` (default), behavior is unchanged from today —
sentinel + exit code remain the contract. When `callback: true`, the
sentinel is still respected as a fallback but the spawned process is
expected to POST `/status` before exiting.

**Auth**: per-run random token (256-bit), passed via env var. The
endpoint refuses requests without the matching token. Localhost-only
binding. Token leaks within a single machine are not in scope; for
that, study a future "minifac in a shared environment" proposal.

**Lifecycle**: the endpoint exists from node spawn to node
termination + a small grace window. Once the run finishes, all
endpoints for that run go away (state is in [[Runs-DB]] for post-run
queries; the live HTTP surface is per-run).

**Sentinel does not go away.** It remains the default and the
fallback. Per-node opt-in keeps the change additive and backwards
compatible.

## Consequences

- Mid-run interaction becomes possible — required for the studio's
  chat-with-a-node + chat-with-a-workflow surfaces
- Status signaling becomes tamper-resistant when opted in (the
  process has to actually invoke the endpoint, not hope the model
  emits a string)
- The endpoint surface needs careful design — see "Open
  Questions" below for what's not pinned in v0
- Claude executor's prompt gains a new instruction block (similar to
  the sentinel-injection from [[0007-Sentinel-Runner-Injects]]): when
  `callback: true`, teach the model to call the endpoint at the right
  times. The model is told to use Bash to invoke `curl`/`fetch`/etc.;
  in a future iteration this becomes an MCP tool.
- The factory schema gains the `callback` knob; loader validates it.
- The runner gains a small HTTP server (or a route registrar when
  embedded in the daemon).
- Run results in [[Runs-DB]] gain a `meta` blob column so the
  callback's structured meta is preserved.

## Alternatives considered

- **File-based mailbox** (e.g., `.minifac/mailbox/<run-id>/`) where
  the process writes JSON and the runner watches. Rejected — much
  higher latency, polling-based, more failure modes, doesn't support
  bidirectional question/answer cleanly.
- **MCP server as the transport.** Considered seriously and *will*
  eventually be the right answer. MCP is well-shaped for tool-like
  bidirectional interaction and Claude Code already speaks it
  natively. For v0 we ship the HTTP transport because (a) it's
  simpler to reason about for the first cut, (b) we can stand up the
  same logical surface as MCP tools later by wrapping the HTTP
  endpoints, and (c) shipping MCP as the primary requires the
  spawned claude to be the *MCP client*, which is a different
  configuration path than today's `--print` mode.
- **Make callback always-on; deprecate sentinel.** Rejected for v0 —
  too much churn for shipped factories (would break every existing
  `examples/sdd.yaml`-derived custom factory). Opt-in is additive;
  the migration to "callback by default" can come once enough
  factories adopt it.
- **Push instead of pull for human messages** (server pushes via SSE
  to the node). Rejected — the node is already a child process; we
  can't easily push to its stdin from outside its own polling. The
  client polls or long-polls `GET /context`.

## Open questions (within scope for the proposal phase)

- Exact JSON schema of each endpoint's request/response — pin in the
  spec, not here.
- Long-poll vs short-poll for `GET /context` — implementation choice;
  pick the simpler one that meets latency needs.
- How `minifac run` (one-shot CLI) surfaces a pending `/question` —
  probably a TTY prompt; document.
- How the viewer surfaces a pending `/question` — chat-style affordance
  in the streaming run view.

## Related

- [[Executor]] — gains the callback option
- [[Sentinel]] — stays as default + fallback
- [[Runner]] — stands up the HTTP surface
- [[Runs-DB]] — gains `meta` for structured per-node result data
- [[0007-Sentinel-Runner-Injects]] — instruction-injection pattern is
  reused for callback-aware nodes
- [[Open-Questions]] — removes the "Hook-enforced sentinel" and
  "Callback / MCP status transport" entries
