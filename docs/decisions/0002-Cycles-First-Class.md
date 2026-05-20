---
status: accepted
date: 2026-05-18
supersedes: []
superseded-by: null
tags: [decision]
---

# 0002: Cycles are first-class in the factory graph

## Context

Factory graphs need to express retry-on-failure and iterate-with-feedback
patterns. A DAG-only model can't represent `verify fails → apply tries
again`. Real workflows (CI hardening, propose-apply-verify-archive,
explore-and-refine) all loop.

But unbounded cycles are an infinite-loop footgun, especially when
each iteration costs real money via an LLM API call.

## Decision

The graph is **directed** with **cycles permitted**, with two
non-negotiable constraints:

1. Every cycle MUST be covered by at least one budget — either
   `max_traversals` on an edge in the cycle, or `max_iterations` on
   a node in the cycle.
2. The loader rejects any uncovered cycle. Failure is at load time,
   not runtime.

The [[Runner]] enforces budgets at scheduling time. Budget exhaustion
ends the [[Run]] as `failed` with reason `budget_exhausted`,
distinguished from `node_failed` (a real failure with no recovery).

## Consequences

- Realistic workflows (the [[SDD-Loop]]'s verify → apply recovery)
  express naturally
- Mistakes that would cause infinite loops fail loudly at load, before
  any API spend
- Two distinct termination reasons (`budget_exhausted` vs `node_failed`)
  let the CLI map to different exit codes (`3` vs `2`)
- The factory schema and graph runner explicitly assume cycles; future
  code touching the graph must not regress to DAG-only assumptions

## Alternatives considered

- **DAG-only.** Forbid cycles entirely; force users to express
  iteration via repetition. Rejected — verbose, doesn't compose, and
  doesn't actually prevent runaway loops (a long DAG works similarly).
- **Allow cycles, runtime cap.** No load-time check; just hard-stop
  the runner after N total node executions. Rejected — the cap is
  arbitrary, errors fire mid-run, debugging the cycle requires reading
  logs instead of validating once.
- **Cycles allowed without budgets, expect users to be careful.**
  Rejected — the cost of one runaway loop is measured in dollars or
  hours, not in user inconvenience.

## Related

- [[Cycle]] — concept
- [[Factory]] — where cycles live in the graph
- [[Runner]] — enforces budgets
- `openspec/specs/factory-schema/spec.md` — "Cycle budgets are mandatory"
