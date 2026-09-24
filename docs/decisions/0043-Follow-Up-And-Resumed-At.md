---
status: accepted
date: 2026-09-24
supersedes: []
superseded-by: null
tags: [decision]
---

# 0043: Tell a node where the run resumed, and that it is a follow-up

## Context

[`0042-Resume-At-Node`](0042-Resume-At-Node.md) resumes a parked run at
one node. It delivers the human's answer as `{{ run.feedback }}` for the
whole run and as a `## Human answer (resume)` block on the seed dispatch
only. It was designed for resuming AT the node that asked.

Scarif's post-plan pause (SCARIFW-1469) needs two more things.

1. **Re-plan.** A human answers a `plan_gate` with a narrower scope, and
   Scarif resumes the run at `plan`, upstream of the gate. `plan` gets the
   block. The gate then runs again and reads the same answer through
   `run.feedback`. Nothing tells it whether the answer was addressed to it
   (so proceed) or re-planned upstream of it (so evaluate the new plan).
2. **Follow-up.** A follow-up run of approved work (red CI, requested
   changes, an unblock) starts again at the start nodes with empty
   feedback. The gate fires again, and it cannot know a human has already
   answered it.

## Decision

- `{{ run.feedback }}` keeps its whole-run meaning.
- `{{ run.resumed_at }}` renders the seed node's id on a resumed run, and
  the empty string otherwise. A gate whose own id equals `resumed_at` was
  answered. A gate that sees another id must judge the new upstream work.
- `RunOptions.followUp = { priorAsks? }` marks a follow-up run.
  `{{ run.follow_up }}` renders `true` or `false`, and
  `{{ run.prior_asks }}` renders `priorAsks` as JSON (`[]` when absent).
  The start nodes do not change. Skipping is the gate's decision.
- All three always resolve, with the value that means "none". This is the
  `run.feedback` convention, because a literal token reads as an
  instruction.

## Consequences

- A gate that binds `run.feedback` alone and treats any non-empty value
  as approval will auto-proceed after a re-plan. Gates that can be
  re-planned past must read `run.resumed_at`. That is a change in the
  factory that owns the gate, not in the runner.
- `priorAsks` is opaque to the runner. Its shape is the caller's contract.

## Alternatives considered

- **Clear `run.feedback` after the seed dispatch.** This would stop the
  gate from reading the answer as approval, but every other node after the
  seed would also lose the answer, which ADR 0042 promises to them. It
  would also make `run.feedback` mean different things on different
  dispatches of the same run.
- **Skip nodes already answered on a follow-up, in the runner.** The
  runner does not know what a gate gates, or whether an old answer still
  holds for the changed work. The gate does, so the runner exposes the
  facts and the gate decides.
- **A structured `priorAsks` type in minifac.** This would couple the
  runner to Scarif's ask model. JSON through a token is enough for a
  prompt to read.

## Related
- [[Run]]
- [`0042-Resume-At-Node`](0042-Resume-At-Node.md)
