---
tags: [concept]
aliases: [factories]
---

# Factory

A factory is a workflow definition: a directed (possibly cyclic) graph
of nodes with edges declaring how control flows. Factories are
*infrastructure* — they live with the minifac tool (as built-in
canonical templates like `minifac:sdd`) or in
`.minifac/factories/<name>.yaml` per repo (custom or extended).

## Anatomy

- **Nodes** have a unique id, an [[Executor]] type, a `with:` payload
  that's executor-specific (e.g. `prompt`, `permission_mode`),
  optional `cwd`, an optional `terminal: true` marker, and an optional
  `max_iterations` budget.
- **Edges** carry `from` / `to` / optional `when` (`on_success` default,
  or `on_failure`) and an optional `max_traversals` budget.
- **Start nodes** are nodes with no `on_success` inbound edge.
  `on_failure` edges are recovery flow, not forward flow, so a node
  whose only inbound is `on_failure` is still a valid entry point.
- **Terminal node** with `terminal: true` ends the run on success.
- **[[Cycle]]s** are first-class but must be bounded — see
  [[0002-Cycles-First-Class]].

## Composition

Repos consume factories by referencing them from a [[Brief]]. A brief's
`factory:` field is resolved against `.minifac/factories/<name>.yaml`
first, then falls back to a built-in `minifac:<name>`. Custom factories
can `extends:` a built-in and override per node. See
[[0008-File-Per-Factory-Composition]].

## Brief-driven vs brief-less

Most factories consume a [[Brief]] (the [[SDD-Loop]] does). Some
factories — nightly drift checks, security triage — don't need per-run
intent and declare `brief: optional | none`. Lookup at invocation time
falls through to the factory name if no brief matches. See
[[0006-Verb-Shape]].

## Related

- [[Brief]] — per-change input
- [[Runner]] — orchestrator that executes the factory
- [[Executor]] — what runs each node
- [[Cycle]] — bounded recovery loops
- [[SDD-Loop]] — canonical example
- [[0004-Factory-vs-Input-Separation]]
- [[0002-Cycles-First-Class]]
