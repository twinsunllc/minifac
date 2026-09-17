## Context

The run loop's entry point is `startNodeIds(factory)` (ADR 0040) and
its budgets are two counters built fresh per run: `iterations` per
node and `edgeTraversals` per `(from, to, when)`. A resume has to
change the first and pre-load the second-to-last without weakening
either for the dispatches that follow.

The state a resume needs is already durable. ADR 0027 put per-node
outputs in `node_outputs`; ADR 0041 kept them there whatever the
node's status, which is exactly what makes a PARKED node's own result
readable when the run comes back; ADR 0014's `priorResults` is the
shape a node's templates read.

## Decisions

### The seed dispatch is exempt from `max_iterations` and traverses no edge

A run parks BECAUSE a node escalated, which typically means that
node's iteration budget is spent — that is often why it escalated. A
seed that honoured the budget would refuse the answer the human just
gave, which makes the whole path useless. So the seed is exempt.

The exemption is exactly ONE dispatch wide: the queue item carries a
`resumeSeed` flag, the guard reads it, and every later dispatch of
the same node arrives through an edge and is checked normally against
the rehydrated counter. A test asserts the budget binds again on the
very next traversal.

`edgeTraversals` starts empty because the seed traverses no edge: it
is not the far end of a cycle, it is the run being handed an answer.
The ask is not a cycle, so it spends no `max_traversals` slot.

**Consequence, stated rather than hidden:** the edge counters start
FRESH for the resumed segment while per-node iteration counts carry
over. The asymmetry is not a principle, it is what is available —
per-node counts are recoverable from `node_executions`, and the
traversal history is persisted nowhere, so there is nothing to
rehydrate it from. The effect is that a resumed segment may traverse
a bounded edge up to its full budget again. That is bounded (the
per-node budget still binds and is the tighter of the two in every
graph we ship), and it is the direction to err in: refusing to route
after a human answered would strand the run a second time. Recording
traversals in `runs.db` was considered and deferred; the trigger is
the first graph whose only bound on a cycle is an edge budget.

### The answer is delivered BOTH as a token and as an injected block

`{{ run.feedback }}` is the natural channel and the one a step should
use. But the steps that would bind it live in
twinsunllc/scarif-workflows, which is not in this ticket's scope, so
today no step binds it. A resume that relied on the token alone would
deliver the answer to nothing.

So the runner also appends a delimited `## Human answer (resume)`
block to the seeded dispatch's prompt. ADR 0007 already establishes
that the runner injects into a prompt when the contract cannot be met
by the step alone. The block is:

- fenced (`-----BEGIN HUMAN ANSWER-----`), because a human's answer
  can itself contain markdown headings and the model has to see where
  it stops;
- appended AFTER template substitution, so nothing a human wrote is
  read as a template token;
- on the SEED ONLY. A later iteration of the same node, reached down
  an edge, is not told the answer again as though it were new — it
  can still read it through the run-wide token.

Once a step binds `{{ run.feedback }}`, the block is redundant rather
than wrong, and removing it is a one-line change behind a spec delta.

### `{{ run.feedback }}` substitutes the empty string when absent

Every other `run.*` field passes an out-of-scope token through
verbatim. This one does not, because a step binding it is asking
"what did the human say" and "nobody said anything" is a real answer
to that question — whereas handing the model the literal
`{{ run.feedback }}` reads as an instruction. Same convention as a
missing `inputs.*` key. A run with no `run` scope at all still passes
through, which keeps the namespace rule intact.

### Reason is recovered from `status` events, not from a column

`node_executions` has no reason column: `sentinel_status` exists but
the runner never writes it. `{{ priorResults.<id>.reason }}` (ADR
0041) is exactly what an escalation-aware step reads, so a rebuilt
state that dropped it would be a worse state than the run had. The
reasons are therefore read off the run's persisted `status` events,
with the same extraction rule the runner applies live, and the
`getRunEvents` filter exists so that read does not scan a
stdout-dominated log.

### The CLI continues the same run row

`minifac run --resume` reuses the recorded run id, worktree and
branch, and calls the new optional `RunStore.reopenRun` so the
resumed dispatches append to the row that is already there. A second
row would make "what did this run cost" and "what did this run do"
two questions with two answers.

No worktree is created, no lazy prune runs, and no per-change
lockfile is claimed: the run being resumed is finished, so there is
no concurrent invocation of it to serialise against, and cutting a
fresh worktree would discard the commits and PRs the whole feature
exists to keep.

## Rejected alternatives

- **A `wait_human` node type.** A first-class node that blocks would
  need the runner to survive the wait — hours or days — which makes
  the runner a daemon with durable state. The ask outlives the
  process; the resume is a second invocation. That is the same shape
  Scarif already uses for every other human gate.
- **Re-running from the start nodes with the answer as feedback.**
  This is what the two observed escalations had to do by hand, and
  it is what the ticket exists to stop: a second plan, a second
  implement, a second PR, and the whole cost again.
- **Persisting edge traversals so the resumed segment inherits them.**
  Deferred; see the consequence above.
