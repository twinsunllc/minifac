---
status: accepted
date: 2026-09-17
supersedes: []
superseded-by: null
tags: [decision]
---

# 0042: Resume a run at one node

## Context

A factory run that needs a human ends as a failed run. In minifac
"emit an ask and halt" is not a node type — it is a node that fails
with no `on_failure` edge, so the run terminates `node_failed` naming
that node and the node's `REASON` line is the ask (scarif-factory
FINDINGS F7). Everything the run established is on disk and in
`runs.db`; there is simply no way back in.

On 2026-09-17 two correct escalations became manual work. In one, the
PR was verified correct but an acceptance criterion could only be
proved after deploy; the run ended, and the only options were
re-ordering the whole graph from `plan` — a second PR and the whole
cost again — or merging by hand. In the other the escalation was a
spec contradiction and the ruling took one sentence; the run could
not take a sentence.

Two prior decisions had already put the pieces in place without
closing the gap. [`0040-Declared-Start-Nodes`](0040-Declared-Start-Nodes.md)
made a node reachable only by `on_failure` stop auto-starting, which
is what makes an escalation node expressible at all.
[`0041-Failed-Node-Outputs`](0041-Failed-Node-Outputs.md) kept a
failed node's declared outputs indexed, which is what makes a PARKED
node's own result readable when the run comes back. What was missing
was the entry point: a way to dispatch ONE named node with the parked
run's `priorResults` already in scope.

Also in scope was how the human's answer reaches the node.
[`0007-Sentinel-Runner-Injects`](0007-Sentinel-Runner-Injects.md)
established that the runner appends to a node's prompt when the
contract cannot be met by the step alone; that precedent decides the
second half of this ADR.

## Decision

`RunOptions.resume = { at, priorResults, iterations, feedback }`
seeds the run's queue with `at` alone instead of the declared start
nodes, rehydrates the parked run's prior results and per-node
iteration counters, and delivers `feedback` to the seeded dispatch.
`minifac run --resume <run> --at <node> [--feedback <file>]` builds
that state from `runs.db` and continues the existing run row.

Three sub-decisions are not obvious and are recorded here.

### 1. The seed dispatch is budget-exempt and traverses no edge

A run parks BECAUSE a node escalated, and a node whose iteration
budget is spent is one of the commonest reasons to escalate. A seed
that honoured `max_iterations` would refuse the answer the human just
gave. So the seeded dispatch is exempt.

The exemption is exactly one dispatch wide. The queue item carries a
`resumeSeed` flag; the guard reads it; every dispatch after it —
including a later iteration of the same node, reached along an edge —
is checked normally against the rehydrated counter. A test asserts
the budget binds again on the very next traversal.

The seed also spends no `max_traversals` slot, because it traverses
no edge. The ask is not a cycle: it is the run being handed an
answer, not the graph looping. An outbound edge whose budget was
exhausted in the parked run is therefore traversable once more in the
resumed segment, which is the point — a node that failed again after
the answer still gets to route.

### 2. Edge counters start fresh; per-node counts carry over

This asymmetry is not a principle, it is what is available. Per-node
iteration counts are recoverable from `node_executions`. Edge
traversals are persisted NOWHERE, so there is nothing to rehydrate
them from.

**The consequence, stated rather than hidden:** a resumed segment may
traverse a bounded edge up to its full budget again, so a run
resumed several times could spend more total traversals of one edge
than its `max_traversals` nominally allows. That is bounded — the
per-node iteration budget still binds and is the tighter of the two
in every graph we ship — and it errs in the right direction:
refusing to route after a human answered would strand the run a
second time, which is the failure this ADR exists to remove.
Recording traversals in `runs.db` was considered and DEFERRED; the
trigger to revisit is the first graph whose only bound on a cycle is
an edge budget rather than a node budget.

### 3. The answer is delivered twice

`{{ run.feedback }}` is the channel a step should use, and it is now
resolved for the whole run (empty string when there is none — unlike
the other `run.*` fields, because a step binding it is asking what a
human said and the literal token would read to a model as an
instruction).

But the steps that would bind it live in
twinsunllc/scarif-workflows, which is out of this work item's scope,
so today NO step binds it. A resume relying on the token alone would
deliver the answer to nothing. So the runner also appends a delimited
`## Human answer (resume)` block to the seeded dispatch's prompt,
per ADR 0007's precedent. The block is fenced, because a human's
answer can itself contain markdown headings; it is appended AFTER
template substitution, so nothing a human wrote is read as a token;
and it lands on the seed ONLY, so a second iteration of the same node
is not told the answer again as though it were new.

Once a step binds the token the block becomes redundant rather than
wrong, and removing it is a one-line change behind a spec delta.

## Consequences

- A parked run is resumable at its escalating node with its results,
  its worktree, its branch and its PRs intact, at the cost of the
  resumed nodes only.
- `RunReason` gains `resume_unknown_node`: a resume naming a node the
  factory does not declare dispatches nothing, because seeding an
  arbitrary node against a human's answer is worse than refusing.
- `RunStore` gains two OPTIONAL methods (`getNodeExecutions`,
  `reopenRun`) and `GetEventsOptions` a `kind` filter. Optional for
  the same reason `deleteNodeOutputsForRun` is: the droid's adapter in
  twinsunllc/scarif-worker is assignable by shape alone, and a
  required method would break its build the moment this one shipped.
- A resumed CLI run cuts no worktree, prunes nothing and claims no
  lockfile. The run it resumes is finished, so there is no concurrent
  invocation to serialise against, and a fresh worktree would discard
  the commits the feature exists to keep.
- `reason` on a rehydrated prior result is read off the run's
  persisted `status` events, because `node_executions` has no reason
  column. A run whose event log has been pruned resumes with `null`
  reasons — the state is thinner, never wrong.

## Rejected alternatives

- **A `wait_human` node type.** A node that blocks would make the
  runner a daemon holding durable state across hours or days. The ask
  outlives the process; the resume is a second invocation, which is
  the shape Scarif already uses for every other human gate.
- **Re-running from the start nodes with the answer as feedback.**
  This is exactly what the two observed escalations had to do by
  hand: a second plan, a second implement, a second PR, the whole
  cost again.
- **Resuming under a new run id.** Then "what did this run cost" and
  "what did this run do" become two questions with two answers.
  `reopenRun` keeps one row.
