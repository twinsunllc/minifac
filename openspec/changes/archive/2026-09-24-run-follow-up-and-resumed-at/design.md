## Context

ADR 0042 delivers a resume answer twice: as `{{ run.feedback }}` for the
whole run, and as a block on the seed dispatch only. That was designed
for resuming AT the asking node. Scarif now also resumes UPSTREAM of it
(a revise that re-plans), and it marks follow-up runs of approved work.

## Decisions

### Keep `run.feedback` whole-run; add `run.resumed_at`

Clearing `run.feedback` after the seed would stop a re-run gate from
reading the answer as its own approval. It would also stop every node
after the seed from reading the answer at all, which ADR 0042 promises
and a step may already bind. So the answer stays, and a separate token
names the seed. A gate compares `{{ run.resumed_at }}` with its own id:
if they are equal, the human answered it; if `resumed_at` names another
node, it must evaluate the new upstream result on its merits.

### `followUp` is a flag plus opaque JSON

The runner does not interpret prior asks. Their shape belongs to the
caller (Scarif sends `{node_id, kind, answer, answered_at}`), and a gate
reads them in its prompt. So `priorAsks` is `unknown[]` rendered with
`JSON.stringify`. `followUp` does not change the start nodes. Whether to
skip is the gate's decision, because only the gate knows what it gates.

### Always resolve, with the value that means "none"

This is the `run.feedback` convention. A literal `{{ run.follow_up }}`
handed to a model reads as an instruction, and "not a follow-up" is a
real answer.
