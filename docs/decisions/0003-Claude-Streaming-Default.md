---
status: accepted
date: 2026-05-18
supersedes: []
superseded-by: null
tags: [decision]
---

# 0003: Claude CLI in stream-json mode is the default executor

## Context

Nodes need a way to run actual work. v0 has exactly one [[Executor]],
and it has to be the one that's most general — capable of editing
files, running commands, doing the full spectrum of an SDD step. Claude
in agentic mode (with tools) is that executor.

For the wire shape: the CLI supports several output modes (plain text,
JSON, stream-json). Stream-json is the only one that gives us
structured per-event streaming, which is what the [[Runner]] needs to
forward events to viewers and persist in the [[Runs-DB]].

## Decision

The `claude` executor invokes the Claude CLI with:

```
claude --print --verbose \
       --input-format stream-json --output-format stream-json \
       [--model X] [--permission-mode bypassPermissions] \
       [--allowedTools ...] [--add-dir ...]
```

- **Input**: a single user message on stdin containing prior run
  history (serialized) plus the node's prompt.
- **Output**: line-by-line stream-json events on stdout. Each line is
  parsed; the final `result` event is scanned for the [[Sentinel]].
- **Status**: sentinel wins, exit code is fallback.

The wire format is owned by the executor file (`src/executor/claude.ts`)
and snapshot-tested. The factory and runner are insulated from CLI
surface changes.

## Consequences

- Real-time streaming to consumers (CLI + daemon both forward events
  as they arrive)
- Run-wide history serializes as a single user-message preamble, which
  is simple but does not preserve turn structure (acceptable trade
  for v0)
- The executor interface stays small: `type` + `run(node, ctx)`
  returning an async iterable of events
- Adding a second executor (`shell`, eventually `codex`) is a new file
  + registration; runner is unchanged

## Alternatives considered

- **Discrete API calls via the Anthropic SDK.** Skip the CLI entirely;
  call the API directly. Rejected for v0 — the CLI bundles Bash, Edit,
  Write, Read tool integrations we'd otherwise have to reimplement.
- **codex / opencode as default.** Rejected — Claude Code is the
  user's daily driver; minifac dogfoods the same surface. Other
  runners earn their place via `pluggable-runners` if/when a real
  second consumer emerges.
- **Plain-text or JSON output (not stream-json).** Rejected — defeats
  the streaming-events goal; viewers would have to wait for run
  completion to see anything.
- **Multi-turn replay of history.** Send each prior node's events as a
  separate user/assistant turn rather than a single preamble. Rejected
  for v0 — adds complexity (role inference) without clear value.
  Open question; can be revisited.

## Related

- [[Executor]]
- [[Runner]]
- [[Sentinel]]
- `openspec/specs/node-executor/spec.md`
- [[0007-Sentinel-Runner-Injects]]
