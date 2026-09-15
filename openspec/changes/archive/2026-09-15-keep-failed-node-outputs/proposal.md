## Why

`NodeResult.outputs` is `null` unless the node terminated `succeeded`
(issue #38; scarif-factory FINDINGS F4). Any verdict that routes by
failing — evaluate's `revise`, verify's CI failure, review's
`needs_rebase` — loses its structured payload: only the one-line
`REASON` reaches the next node, via the prior-results preamble, while
the node's `result.json` sits on disk in its outputs directory.
Observed: `evaluate#1 failed reason="revise: …" outputs=null` with a
complete `result.json` beside it. The Scarif "evaluate" step now
depends on this — it fails on purpose with `verdict: revise` and the
downstream implement node must read its findings, `criteria_grades`,
`cycle_summary` and `recurring_themes`, not a one-liner.

ADR 0027 skipped validation on failed nodes so that "a node that
honestly reported failure isn't additionally blamed for not producing
outputs". That is the right rule for *enforcement*; it was never a
reason to drop what the node *did* produce.

## What Changes

- **MODIFIED** `graph-runner` "Post-execution outputs validation": the
  validator runs whenever the node declares `outputs:`, whatever its
  terminal status. On a `failed` node nothing is enforced — no nudge, no
  override, reason preserved — but present-and-satisfied outputs are
  indexed, and an unsatisfied `required` key is a stderr warning rather
  than a status change.
- **MODIFIED** `graph-runner` "`NodeResult.outputs` field on prior
  results" and "Prior-results accumulate across node executions":
  `outputs` carries the present-and-satisfied index regardless of
  status, including the partial index when the missing-required-output
  override fires. `null` only when no `outputs:` was declared or nothing
  landed.
- **ADDED** `graph-runner` "Prior-result status and reason tokens":
  `{{ priorResults.<id>.status }}` and `{{ priorResults.<id>.reason }}`
  so a downstream prompt can branch on how its source ended.
- Nodes that succeed with all required outputs present behave exactly
  as today. `NodeResult`'s shape is unchanged, so the executor preamble,
  `runs.db` and the viewer need no change.
- Edge payloads (`carries:`) were considered and deferred; see ADR 0041.

## Impact

- `src/runner/run.ts` (post-execution validation block)
- `src/runner/substitute.ts` (two new token forms)
- `src/runner/run.test.ts`, `src/runner/substitute.test.ts`,
  `src/runner/outputs-integration.test.ts`
- `docs/concepts/Outputs.md`, `docs/concepts/Factory.md`,
  `docs/concepts/Runner.md`; ADR 0041
- Behavior change only for factories whose `on_failure` targets already
  reference a failed node's outputs — those tokens substituted `""` and
  now substitute the path/contents. No shipped example does.
