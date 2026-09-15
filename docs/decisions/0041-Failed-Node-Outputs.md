---
status: accepted
date: 2026-09-15
supersedes: []
superseded-by: null
tags: [decision]
---

# 0041: Outputs of failed nodes stay addressable

## Context

[`0027-Node-Outputs`](0027-Node-Outputs.md) made a node's declared
outputs flow to downstream nodes through `NodeResult.outputs` and the
`{{ priorResults.<id>.outputs.<key>[:read] }}` tokens. It also ruled
that required-output enforcement "applies only on sentinel-succeeded
nodes. A failed sentinel short-circuits the check — a node that
honestly reported failure isn't additionally blamed for not producing
outputs it would have produced had the work succeeded."

The implementation took *skip the check* to mean *skip the index*:
`src/runner/run.ts` ran the validator only on `succeeded`, so every
failed node's `outputs` was `null`. On the missing-required-output
override the partial index was persisted to `runs.db` and carried on
the failure event, but the `priorResults` snapshot was zeroed too.

That is fine for a verify node whose failure means "no work product".
It is wrong for the shape every real factory has: a **verdict that
routes by failing**. scarif-factory's translation of Scarif's
standard-implementation workflow (FINDINGS F4, issue #38) has
evaluate fail on purpose with `verdict: revise` so the `on_failure`
edge carries the run back to implement, and verify fail on a red CI
run for the same reason. Each writes a complete `result.json` —
findings, `criteria_grades`, `cycle_summary`, `recurring_themes`,
`waived_design_findings`, `failure_details` — and then loses it. What
survives is the one-line `REASON` in the preamble:
`evaluate#1 failed reason="revise: …" outputs=null`, with the file
sitting beside it on disk. The steps compensated by cramming every
feedback item onto the `REASON` line and having implement re-read the
*succeeded* review results and fetch CI logs itself. F18 (no
cross-cycle narrative) is the same loss seen from the other end.

Two remedies were on the table: keep a failed node's outputs
addressable, or add an edge payload (`carries:`) so the edge names
what it moves.

## Decision

**A node's outputs are recorded and addressable through `priorResults`
whether the node succeeded or failed.** The validator runs whenever a
node declares `outputs:`; the node's terminal status decides what is
*enforced*, never what is *kept*.

- **Succeeded**: unchanged. Required outputs are enforced — the nudge
  loop, then the `missing_required_output` override. One difference:
  when the override fires, the partial index stays on the
  `priorResults` entry instead of being forced to `null` (it was
  already persisted and on the failure event's `meta.partial_index`).
- **Failed**: the reason is preserved and nothing is enforced — no
  nudge, no override. The outputs directory is scanned once; every
  present-and-satisfied output (a `value` whose `<key>.json` parses, a
  `file` found unambiguously, a non-empty `directory`) goes on the
  index. A `required` key that is unsatisfied is a stderr warning
  (`outputs_warning: node "<id>" failed and is missing required
  outputs: …; indexed: …`) so the operator sees a verdict lose its
  payload before a downstream node reads `""`.
- **Uniform rule**: `NodeResult.outputs` is the present-and-satisfied
  index, or `null` when no `outputs:` was declared or nothing landed.

**Downstream templates can see how the source ended.** Two additive
token forms: `{{ priorResults.<id>.status }}` → `succeeded` |
`failed`, and `{{ priorResults.<id>.reason }}` → the recorded reason
or `""`. Both substitute `""` when the node has no prior result, the
convention for every other missing prior-result lookup. The preamble
already carried these as JSON; the tokens let a prompt branch on them
without parsing it.

A revise loop now reads as:

```yaml
nodes:
  evaluate:
    outputs: { result: { type: value, required: true } }
  implement:
    with:
      prompt: |
        Last evaluate ended {{ priorResults.evaluate.status }}
        ({{ priorResults.evaluate.reason }}). Its findings:
        {{ priorResults.evaluate.outputs.result:read }}
edges:
  - { from: evaluate, to: implement, when: on_failure, max_traversals: 5 }
```

`NodeResult`'s shape is unchanged. The executor preamble, `runs.db`,
`minifac runs --json` and the viewer need no change; a
`node_outputs` row for a failed iteration joins to `node_executions`
for its status as before.

## Consequences

- Every verdict that routes by failing keeps its structured payload.
  Steps stop overloading the `REASON` line and stop re-deriving what
  the failed node already wrote.
- A node's own earlier iterations are readable after a failure, so a
  cross-cycle narrative (F18) can be carried by the node that owns it.
- The 0027 rule is narrowed to its actual content: failure short-
  circuits *enforcement*. "Downstream nodes never see a `null` where a
  typed value was declared" still holds for succeeded nodes; for
  failed nodes a declared-but-absent output is `""`, as an optional
  output always was.
- `on_failure` targets that referenced a failed node's outputs got
  `""` before and now get the path or contents. No shipped example did.
- The "node errored" vs "node judged fail" distinction (F10) is still
  absent. This change makes the payload available in both cases; it
  does not tell them apart.

## Alternatives considered

- **Edge payloads (`carries:`), as in Scarif's `WorkflowEngine`.**
  *Deferred, not rejected.* An edge that names what it moves is a real
  design and fits the F3 value-conditioned-edge direction. But it is a
  second data-flow surface next to `priorResults` — new schema, new
  resolution rules, new template namespace — and it does not remove the
  need for this change: a `carries:` edge from a failed node would
  still have to read an index that was `null`. Making the existing
  surface honest costs one block and no schema; `carries:` can be
  added on top when a factory needs an edge to *select* rather than
  merely *expose*. Revisit with F3.
- **A declared `on_failure:` outputs set** (the issue's minimum). Rejected:
  it makes the author say twice which outputs a verdict node writes,
  and the split has no runtime meaning once enforcement is the only
  status-dependent behavior. It is this decision with more YAML.
- **Enforce required outputs on failed nodes too** (fail with
  `missing_required_output` instead of warning). Rejected: it would
  re-blame a node for the thing 0027 said not to blame it for, and it
  would turn a verify node that crashed before writing anything into
  a different reason string than the crash. The warning gives the
  operator the signal; the reason stays the node's own.
- **Add `outputs_warning` / `missing_outputs` to `NodeResult`.**
  Rejected: it changes the preamble shape (pinned by the
  `node-executor` scenario "Prior-results JSON keys match the
  NodeResult shape"), `runs.db`, and `runs --json` for a fact that is
  already an event and already observable downstream as an absent key.
- **Expose `status` only, not `reason`.** Rejected: `reason` is the
  line every step today already depends on; giving templates the
  status without the sentence they were already reading would be
  odd, and it is the same regex.

## Related

- [`0027-Node-Outputs`](0027-Node-Outputs.md) — the enforcement rule
  this decision narrows to its actual content
- [`0014-Structured-Prior-Results`](0014-Structured-Prior-Results.md)
  — the `priorResults` surface the tokens read
- [`0029-Node-Outputs-MCP`](0029-Node-Outputs-MCP.md) — the MCP
  transport; unchanged, both transports land on the same file
- `docs/concepts/Outputs.md` — template access and post-execution
  validation
- twinsunllc/scarif-factory `FINDINGS.md` F4, F10, F18 — the consumer
  evidence; issue #38
