---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0007: Runner auto-injects sentinel mechanics; factory owns per-node criteria

## Context

The [[Sentinel]] (`MINIFAC_STATUS: succeeded|failed`) needs to be
described to the model in every claude-executor prompt. Pre-this-decision,
each factory's YAML carried a ~15-line `## Status signaling` block in
every node's prompt — boilerplate that included the regex, where to
emit it, and the success/failure semantics.

For a four-node factory like the [[SDD-Loop]], that's ~60 lines of
identical boilerplate distributed across the YAML. Updates to the
sentinel format (a future regex change) would require touching every
shipped factory.

## Decision

**The [[Runner]] auto-injects sentinel-emission instructions** into
every claude-executor prompt before sending. The factory's prompt
carries only:

1. Per-node responsibility (what to do)
2. Per-node success/failure *criteria* ("success means every verify
   command exited 0")

The runner appends the mechanics: the regex, where it must appear,
the format, the fallback-to-exit-code behavior.

A per-factory opt-out knob (`emit_sentinel_instructions: false`) is
reserved for future executors that don't need it (e.g. `shell`),
but defaults to on for the claude executor.

## Consequences

- Factory definitions shrink (~60 lines per SDD-style factory)
- Sentinel format changes are atomic — one runner change, all factories
  benefit, no copy-paste rot
- Per-node criteria are still factory-specific (success/failure
  semantics differ per phase), and stay in the factory prompt
- Briefs are unaffected — brief authors never write sentinel
  instructions under any model
- The [[Runner]] now owns both ends of the sentinel contract: it
  emits the instructions on send, parses the result on receive

## Alternatives considered

- **Factory definitions carry the sentinel block** (status quo).
  Rejected — repetitive, error-prone, makes future format changes
  expensive.
- **No sentinel instructions in prompts; rely on the model knowing
  the convention.** Rejected — too fragile. The model needs explicit
  instructions to emit the marker reliably.
- **Convention: append a standard block via a YAML anchor / include.**
  Rejected — YAML anchors are ugly and don't span files; we'd be
  inventing a templating layer just for one use case.
- **Hook-enforced sentinel** (a Stop hook on the spawned claude
  session writes structured status). Sharper but heavier; deferred
  to a future change. See [[Open-Questions]].
- **Callback transport** (HTTP/MCP) instead of text sentinel.
  Bidirectional, more robust, *required* for mid-run human-in-the-loop
  interaction — but heavier infrastructure. Deferred to its own
  proposal when the bidirectional need surfaces. See [[Open-Questions]].

## Related

- [[Sentinel]]
- [[Runner]]
- [[Executor]]
- [[Factory]]
- [[Open-Questions]] — hook + callback are filed there
