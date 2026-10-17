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
[[0002-Cycles-First-Class]]. The edge's `when` makes no difference: a
cycle closed only by `on_error` edges needs a budget too
([[0052-On-Error-Edges]]), and so does one closed by value edges such as
`when: { output: result.decision, equals: revise }`
([[0055-Value-Edges-And-Node-Routing]]). A value edge's traversals are
counted under `<from>-><to>:output:<path>=<JSON>`. A node's `routes:`
entries are edges for this rule as well: a cycle closed by a route needs
`max_traversals` on the route entry (`{ to: implement, max_traversals: 2 }`)
or `max_iterations` on a node in the cycle. A route's traversals are
counted under `<from>-><to>:route`, and park/resume carries the count.

This is enforced at load time, not runtime — so a buggy factory can't
sneak through.

The rule is per elementary cycle ([[0053-Loop-Budgets-Per-Cycle]]): an
uncapped inner loop is not covered by a budget on another loop it shares
nodes with. A node's `max_iterations` covers every cycle through that
node. Until the next major version the loader enforces this in two
steps: a loop with no budget anywhere is a load error, and an uncovered
cycle inside an otherwise budgeted loop loads with a warning
(`LoadedFactory.warnings`). `minifac run` writes a `warning:` line to
stderr; `minifac autorun` logs a `load-warning` event, and in its TUI
lists the warning below the briefs; a run started through `minifac
serve` returns it in the `POST /api/runs` body's `warnings` and opens its
event stream with a `warning:` line, which is also written to
[[Runs-DB]] as the run's first event, so a restarted daemon replays it. The
`strictBudgets` loader option and the `--strict-budgets` flag make the
warning an error now.

## Knowing which pass you are on

A node in a cycle can read its own pass and its loop budget from
template tokens instead of counting earlier results or keeping a
`max_cycles` input equal to the edge's budget by hand:
`{{ node.iteration }}` (1, 2, 3, …), `{{ edge.traversals }}` (how many
times the edge that queued this dispatch has been taken, `0` on a start
node) and `{{ edge.max_traversals }}` (that edge's budget, empty when it
has none). See [[Factory]]'s "Templating tokens" and
[[0050-Iteration-Traversal-Tokens]].

## Results accumulate across iterations

A node's second iteration in a cycle sees one `NodeResult` entry per
completed node execution that came before it. The [[Runner]] passes
the structured `priorResults` array into each scheduled node's
`RunContext`. So `apply` on iteration 2 has:

- `apply` iter 1 result (status: `succeeded`, reason: `null`)
- `verify` iter 1 result (status: `failed`, reason: the [[Sentinel]]
  REASON line — *the* feedback channel the cycle iterates against)

The REASON line is load-bearing here: it's how a failing node tells
the next iteration what to do differently. Without a meaningful
REASON, the cycle still iterates but `apply` doesn't know what
broke. The runner-injected sentinel block
([[0007-Sentinel-Runner-Injects]]) ensures every claude-executor
node ships with that requirement by default. See
[[0014-Structured-Prior-Results]].

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
