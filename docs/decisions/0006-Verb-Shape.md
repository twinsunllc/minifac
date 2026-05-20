---
status: accepted
date: 2026-05-19
supersedes: []
superseded-by: null
tags: [decision]
---

# 0006: `minifac run <thing>` with lookup precedence; drop direct-factory invocation

## Context

Pre-this-decision, `minifac run` took a factory YAML path directly.
With [[Brief]]s as first-class inputs (see
[[0004-Factory-vs-Input-Separation]]), there are now several things
the user might want to "run":

- A brief by path: `inputs/foo.md`
- A brief by name: `foo` (looking up `inputs/foo.md`)
- A factory directly (for brief-less factories like nightly drift
  checks): `spec-drift-watch`
- A factory YAML file directly (legacy): `examples/sdd.yaml`

We need a verb shape that's ergonomic, unambiguous, and doesn't sprawl
into two parallel invocation patterns.

## Decision

One verb: **`minifac run <thing>`**, with auto-detect by lookup
precedence:

1. If `<thing>` is a path (contains `/` or ends `.md`) → treat as
   brief path
2. Else, try `<inputs_dir>/<thing>.md` → if it exists, treat as brief
   by name (briefs take precedence)
3. Else, resolve `<thing>` against the repo's configured factories
   (`.minifac/factories/<thing>.yaml`) or minifac's built-ins
   (`minifac:<thing>`) → treat as brief-less factory invocation
4. Else, error

**Direct factory YAML invocation is dropped.** Factories are
referenced by name, either via a brief or as a brief-less invocation.
Even the escape-hatch custom factory in `.minifac/factories/` is
invoked by name, not by path.

Brief-less factories declare `brief: required | optional | none` in
their definition so the loader can error early on missing-but-required.

## Consequences

- One verb to learn; one mental model
- Briefs and brief-less factories coexist without conflict
- Examples like `examples/sdd.yaml` (today's shipped template) are no
  longer directly invokable; users author a brief or invoke the
  factory by name
- Scheduling/triggering (cron, webhooks, watchers) is a separate
  layer that just calls `minifac run` — the verb shape supports
  unattended invocations naturally
- The CLI is forward-compatible: future automation tooling can
  produce briefs OR invoke factories directly through the same verb

## Alternatives considered

- **Two verbs**: `minifac run <brief>` and `minifac invoke <factory>`.
  Rejected — splits the mental model unnecessarily; auto-detect
  resolves the ambiguity without two verbs.
- **Path-only invocation**: `minifac run inputs/foo.md`, always.
  Rejected — once you have 5+ briefs, typing the path every time is
  friction. The name-shortcut is cheap.
- **Keep `minifac run <factory.yaml>` for backwards-compat.**
  Rejected — two parallel patterns ("run a brief" vs "run a factory
  file") creates the same conceptual confusion the
  factory-vs-input split was meant to resolve.
- **Flag-based**: `minifac run --brief foo` / `--factory foo`.
  Rejected — verbose for the common case; auto-detect is cheaper.

## Related

- [[Brief]]
- [[Factory]]
- [[0004-Factory-vs-Input-Separation]]
- [[0005-Brief-Schema]]
