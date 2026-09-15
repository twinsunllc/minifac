---
tags: [concept]
aliases: [executors, node-executor]
---

# Executor

An executor is what actually runs a node in a [[Factory]]. The
[[Runner]] dispatches each node to an executor based on the node's
`executor:` field; the executor returns a stream of events (`stdout`,
`stderr`, `status`) which the runner forwards to consumers and records
in the [[Runs-DB]].

## Current executors

- **`claude`** — spawns the Claude CLI in stream-json mode. Sends a
  single user message on stdin containing prior run history + the
  node's prompt. Parses stdout for the [[Sentinel]] to determine the
  node's status. See [[0003-Claude-Streaming-Default]].

Future:
- **`shell`** — runs a shell command, exit code drives status. Deferred
  to phase 4; drop-in for verify nodes once API cost matters.

## `with:` schema (claude executor)

| Field | Purpose |
|---|---|
| `prompt` | The instructions sent to Claude |
| `model` | Optional model override |
| `args` | Optional pass-through args to the CLI |
| `permission_mode` | `default`, `accept_edits`, `bypass_permissions` |
| `allowed_tools` | Allowlist when permission_mode is restrictive |
| `add_dirs` | Additional read/write directories beyond `cwd` |

YAML keys are snake_case; the claude CLI maps to camelCase
internally (`bypass_permissions` → `bypassPermissions`).

## Session resume

When a node declares `resume: <node-id>` (see [[Factory#Cross-node
session resume]]), the [[Runner]] resolves the target's captured
session id and threads it through the run context. The claude executor
turns that into `--resume <session-id>` on the spawned CLI, emitted
after `--mcp-config` and **before** `--model`, the authority flags, and
the `with.args` passthrough. Nodes without `resume:` produce a
byte-identical argv to before the feature existed.

`--resume` and `--model` are emitted together on purpose — continuing
an expensive node's conversation on a cheaper model is the point.
Three things are worth knowing:

- **The cache is invalidated by the model swap.** The resumed turn
  re-sends the accumulated history uncached at the new model's rate,
  so a cascade pays for the context transfer once. Expected, not a
  regression — and still cheaper than making the second model
  re-explore.
- **MCP config does not carry over.** A resumed invocation applies the
  `--mcp-config` it is given; the original invocation's servers are
  *not* restored. Each node sees exactly its own per-dispatch tool set.
- **Nothing is validated locally.** The executor never inspects the
  CLI's session storage. An unreadable session or an unknown model id
  surfaces as a non-zero exit through the ordinary exit-code path.

Whether an executor can do this at all is declared by its
`supportsResume` flag (the claude executor sets it `true`); the runner
refuses a `resume:` node routed to an executor that sets it `false`.

## Status signaling

The claude executor combines two mechanisms:

1. **Sentinel** in the model's final message — wins when present
2. **Exit code** — fallback when sentinel is absent

The [[Sentinel]] format and regex live in the [[Runner]], which
auto-injects sentinel-emission instructions into every prompt. The
factory's prompt only specifies per-node success/failure *criteria*.
See [[0007-Sentinel-Runner-Injects]].

## Interface

The executor interface is intentionally small (`type` + `run(node, ctx)`
returning an async iterable of events). Adding a second executor is a
new file plus registration; the runner is unchanged. Formal abstraction
("pluggable runners") is deferred until there's a real second consumer.

## Related

- [[Node]] in a [[Factory]] — selects the executor
- [[Runner]] — dispatches to the executor
- [[Sentinel]] — how the executor reports status
- [[Permission-Mode]] (in [[0003-Claude-Streaming-Default]])
- [[0003-Claude-Streaming-Default]]
- [[0007-Sentinel-Runner-Injects]]
