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
- **`check-merge`** — a read-only probe of whether the worktree's HEAD
  merges cleanly into a base branch. See the `check-merge-step` spec.
- **`command`** — runs declared shell commands in order, with no model,
  and maps their exit codes to the node's status, reason and `result`.
  See [[#`command` executor]] and [[0051-Command-Executor]].

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

## `command` executor

Runs `with.commands` in order, each as `/bin/sh -c <run>` in its own
process group, and writes `<outputs_dir>/result.json`. The node succeeds
iff every command met its `expect`. Full rules: [[0051-Command-Executor]].

| Field | Purpose |
|---|---|
| `commands` | Required, non-empty list, run in order |
| `commands[].id` | Required, unique; names the command in the result and in a generated reason |
| `commands[].run` | Required shell string; template tokens reach it as env vars, so do not quote them |
| `commands[].cwd` | Optional; relative to the node's cwd; template-rendered |
| `commands[].timeout_seconds` | Optional, default 600. SIGTERM to the group, SIGKILL 5 s later |
| `commands[].expect` | Optional `{ exit: N }` or `{ exit: [N, …] }`; default `{ exit: 0 }` |
| `commands[].tool` | Optional binary that must resolve (on `PATH`, or as a path from `cwd`); otherwise the command is red with `host_missing` and never runs |
| `continue_on_red` | Optional, default `false`: stop at the first red command |
| `result_from` | Optional command id whose stdout (less `REASON:` lines) is a JSON object merged into the result |
| `result_file` | Optional path under `run.outputs_dir` holding a JSON object merged into the result; not with `result_from` |

`result.json` holds the merged keys plus `commands`, one entry per command
reached: `id`, `exit_code`, `signal`, `duration_ms`, `host_missing`,
`timed_out`, `met`, and `stdout_tail` / `stderr_tail` (each at most 8192
bytes). Declare `outputs: { result: { type: value } }` to index it.

Cancelling the run (its `abortSignal`) SIGTERMs the running command's
group, SIGKILLs it after the grace, and starts no further command.
minifac's exit SIGKILLs every running command's group. So does SIGINT,
SIGTERM or SIGHUP when nothing else listens for it, before minifac dies by
the signal. A host with its own listener for the signal owns the drain:
running commands are left to finish, and the host stops them sooner with
the run's `abortSignal` or `killAllCommandGroups()`. An embedder that ends
its process without Node's `exit` calls `killAllCommandGroups()` first.

On failure the node's reason is the last `REASON: …` line a command printed
on stdout, or else one naming the first red command
(`test: exit 2, expected [0]`). A result that fails to parse outranks both.

A gate shaped like scarif-factory's `plan_gate`:

```yaml
plan_gate:
  executor: command
  with:
    result_from: gate
    commands:
      - id: gate
        tool: python3
        run: python3 bin/plan_gate.py {{ priorResults.plan.outputs.result }}
        timeout_seconds: 60
  outputs:
    result: { type: value, required: true }
```

The script prints `{"clears_when": …, "resume_on_revise": true}` and
`REASON: escalate: …`, then exits 1 to escalate. The keys land in the
result, and an `on_failure` edge sees the reason as
`{{ priorResults.plan_gate.reason }}`.

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
- [[0051-Command-Executor]]
