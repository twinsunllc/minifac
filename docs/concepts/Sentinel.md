---
tags: [concept]
aliases: [sentinel, status-sentinel, MINIFAC_STATUS]
---

# Sentinel

The sentinel is how a node signals its success or failure to the
[[Runner]] beyond just exit code. The model in a Claude session ends
its final message with a `MINIFAC_STATUS:` line; the [[Executor]] parses
it; sentinel beats exit code in both directions.

## Format

```
MINIFAC_STATUS: succeeded
```

or, on failure:

```
MINIFAC_STATUS: failed
REASON: <one-line description>
```

Regex (canonical):

```
/^MINIFAC_STATUS:[ \t]*(succeeded|failed)\b[ \t]*(?:\r?\nREASON:[ \t]*(.*))?/m
```

The sentinel must appear in the model's *final* assistant message, in
the stream-json `result` event. Earlier occurrences are overwritten by
later ones (last-one-wins).

## Precedence

1. Sentinel present → it wins (sentinel `failed` overrides exit 0;
   sentinel `succeeded` overrides exit non-zero)
2. Sentinel absent → fall back to exit code (`0` = succeeded,
   non-zero = failed)

## Who writes what

- **The [[Runner]]** auto-injects the sentinel-emission instruction
  block (regex, format, where it must appear) into every claude-executor
  prompt. See [[0007-Sentinel-Runner-Injects]].
- **The [[Factory]]** declares the per-node success/failure *criteria*
  in its prompt — e.g. "success means every verify command exited 0."
- **The [[Brief]]** is unaffected — brief authors never write sentinel
  instructions.

## Why this shape

The sentinel is the v0 answer to "the model knows it failed but its
exit code is 0." It's a text convention enforced by parsing.

Cheaper, more robust alternatives are filed under [[Open-Questions]]:

- **Hook-enforced sentinel**: a Stop hook on the child claude session
  extracts the sentinel from the transcript and writes structured
  status. Same regex, harder to bypass.
- **Callback transport**: the spawned session POSTs to an HTTP endpoint
  or invokes an MCP tool. Bidirectional, structured, tamper-resistant
  — required eventually for mid-run human-in-the-loop interaction.

Sentinel suffices for v0 and the next several phases.

## Related

- [[Executor]] — parses the sentinel
- [[Runner]] — injects the instructions
- [[Factory]] — declares per-node criteria
- [[0007-Sentinel-Runner-Injects]]
- [[Open-Questions]] — hook + callback alternatives
