---
tags: [concept]
aliases: [cycles, retry-loop, recovery-loop]
---

# Cycle

A cycle is a loop in the [[Factory]]'s graph — a path of edges that
returns to a previous node. Cycles are first-class in minifac; they're
how recovery and iteration are expressed.

## Canonical example

The [[SDD-Loop]]:

```
propose → apply → verify → archive (terminal)
              ▲       │
              └── on_failure
                  (max_traversals: 3)
```

When `verify` fails, it routes back to `apply` for another iteration.
The `verify → apply` edge has `max_traversals: 3`, so the loop is
bounded.

## Bounded by construction

Every cycle MUST be covered by at least one budget — either
`max_traversals` on an edge in the cycle or `max_iterations` on a node
in the cycle. The loader rejects unbounded cycles. See
[[0002-Cycles-First-Class]].

This is enforced at load time, not runtime — so a buggy factory can't
sneak through.

## History accumulates across iterations

A node's second iteration in a cycle sees its own prior outputs *and*
everything emitted in between. The [[Runner]] passes the full run-wide
history into each node's `RunContext`. So `apply` on iteration 2 has:

- `apply` iter 1 events
- `verify` iter 1 failure events (the reason we're back)

This is what makes cycles actually iterative rather than just "re-run
with the same inputs."

## Budget exhaustion

When a cycle's budget is exhausted, the [[Run]] ends with status
`failed` and reason `budget_exhausted`. Distinct from `node_failed`
(a failure with no recovery path) so the CLI can map to a different
exit code.

## What cycles are good for

- Recovery: verify fails → apply tries again
- Iteration: refine-against-feedback patterns
- Human-in-the-loop gating (future): pause and re-enter on input

What cycles are *not*:

- A scheduling primitive (a cycle that never terminates is rejected
  at load time)
- A way to express "do something N times" — that's `max_iterations`
  on a single node

## Related

- [[Factory]] — defines the graph
- [[Runner]] — enforces budgets at scheduling time
- [[Node]] (in [[Factory]]) — carries `max_iterations`
- [[Edge]] (in [[Factory]]) — carries `max_traversals`
- [[SDD-Loop]] — example cycle
- [[0002-Cycles-First-Class]]
