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
