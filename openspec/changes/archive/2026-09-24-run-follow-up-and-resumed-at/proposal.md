## Why

Scarif's post-plan pause (a `plan_gate` node that escalates when a plan
runs large) exposed two things a node cannot see today (SCARIFW-1469).

- A human who wants a narrower scope answers the gate with a revise, and
  Scarif may now resume the run at `plan` rather than at the gate. The
  answer reaches `plan` as the injected block, and `{{ run.feedback }}`
  stays set for the whole run (ADR 0042). When `plan_gate` runs again it
  reads that same answer and cannot tell "the human answered me" from
  "the human's answer re-planned upstream of me".
- A follow-up run (red CI, requested changes, an unblock) starts again at
  the start nodes with empty feedback. Any gate after `plan` fires again
  on work a human has already approved, and the gate has no way to know.

## What Changes

- **ADDED** `graph-runner` "Resume-seed, follow-up and prior-asks
  run-scope tokens": `RunOptions.followUp = { priorAsks? }`, and three
  always-resolving tokens `{{ run.resumed_at }}`, `{{ run.follow_up }}`
  and `{{ run.prior_asks }}`.
- `{{ run.feedback }}` is unchanged. It is deliberately NOT cleared after
  the seed dispatch (ADR 0043).

## Impact

- Affected specs: `graph-runner`
- Affected code: `src/runner/run.ts`, `src/runner/substitute.ts`,
  `src/runner/resume.ts`, `src/index.ts`
- No breaking change. Without `followUp` and `resume`, the new tokens
  render `false`, `[]` and the empty string. Before this change they
  passed through verbatim.
