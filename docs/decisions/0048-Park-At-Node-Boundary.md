---
status: accepted
date: 2026-10-10
supersedes: []
superseded-by: null
tags: [decision]
---

# 0048: Park a run at a node boundary, and resume it as a pause

## Context

Scarif runs a factory job's whole minifac graph inside one claimed stage.
`pause-semantics` says a pause does not kill the running stage, so pausing
a factory job held only what came after the graph. The captain ruled
(SCARIFW-2222) that a pause should let the node in flight finish, park the
run before its next node, and resume it there on unpause. scarif-spec's
`factory-pause-at-node-boundary` (scarif-spec#365, design D1–D4) is the
contract; this ADR records how minifac meets it.

minifac had no point between nodes where a caller could stop a run.
`abortSignal` does not fit. Checked at the queue head, it reports
`user_quit` with no node, so nothing says where to resume. Checked during
a dispatch, it abandons the node in flight, which is the kill a pause must
not do. The resume entry point, [`0042`](0042-Resume-At-Node.md), resumes
an ANSWERED ask, so it grants the seed a `max_iterations` exemption and the
human-answer block. [`0043`](0043-Follow-Up-And-Resumed-At.md) renders
`run.resumed_at` as the seed. Every edge budget starts at zero. A pause is
none of those things.

## Decision

### 1. One hook, consulted once a dispatch is admitted

`RunOptions.onNodeBoundary({ nodeId, iteration, first })` returns
`"continue"` or `"park"`, synchronously or as a promise. The runner calls
it at the queue head:

- AFTER the dispatch is admitted: the node's `max_iterations` check passed
  and its executor resolved. Edges are budgeted by `max_traversals` when
  traversed, so a queued dispatch was already admitted by them. A park
  therefore records a dispatch the run was going to make, and the resume
  needs no exemption to make it (spec D1). The ticket's wording, "before
  the dispatch decision", predates the spec; the spec governs.
- BEFORE the iteration is spent, the outputs directory exists,
  `recordNodeStart` is called or the executor starts. A parked dispatch
  leaves no trace in `node_executions`, so `resumeStateFromStore` rebuilds
  exactly the counts the resume should start from.
- Before the first dispatch too (`first: true`), and never after a
  terminal node or an unrecovered failure, since there is no next
  dispatch. That includes the seed of an answer, quota or failed-run
  resume, which is admitted only by 0042's exemption; §4 says how a park
  there keeps it.
- Only when exactly one dispatch is pending. A fan-out boundary is not
  consulted and does not park; the run parks at the next single-pending
  boundary or runs to its end (spec D1). One pending dispatch means one
  seed, which is all 0042's `at` can express. "Pending" is the raw queue:
  a queued dispatch a later budget check would skip still counts, so a
  fan-out can defer a park slightly longer than strictly needed.

### 2. `parked` is its own status

A park returns `status: "parked"`, `reason: "parked"`, `proximateNodeId`
and `parked: { nodeId, iteration, pending, edgeTraversals, resumeSeed }`,
and the run
row is finalized `parked`. `iteration` was not spent. `pending` holds the
one entry, keeping the shape spec D2 names for a later multi-seed
resume. Brief mark-done does not run.

### 3. The hook fails open, with a timeout

A throw, a rejection, or no answer within `nodeBoundaryTimeoutMs`
(default `DEFAULT_NODE_BOUNDARY_TIMEOUT_MS`, 10 s) counts as continue.
The failure is a `stderr` event (node `__boundary__`) on `onEvent` and in
the store, and the hook is consulted again at the next boundary. A
control-plane outage must not park every running job; a pause one node
late is the cheaper error (spec D1). The 10 s is a backstop, not a tuned
value: the caller should bound its own read more tightly. A
timed-out hook's promise is abandoned, not cancelled.

### 4. A pause resume is not an answer

`ResumeState.reason` is `"answer"` (or absent, today's meaning) or
`"pause"`. On a pause resume:

- the seed gets no `max_iterations` exemption. It is checked like any
  dispatch, and §1 means the same counters admitted it before the park;
- no `## Human answer (resume)` block is appended. `feedback` is the
  parked run's `run.feedback`, carried over, and renders through the
  token only;
- `run.resumed_at` renders `resumedAt`, the value the parked run had
  (empty when absent), not the seed's id. A gate comparing its id to it
  sees what it saw before the park (spec D3).

One exception keeps a park from changing a run's outcome. The seed of an
answer, quota or failed-run resume holds 0042's privileges, and §1
consults the hook before it too. A park there dispatched nothing, so the
privileges were never used. `parked.resumeSeed` is `true` for exactly that
park. The caller hands it back as `ResumeState.resumeSeed` on the pause
resume, and that seed, and only that seed, gets the privileges again: the
`max_iterations` exemption and, when `feedback` (the parked run's, which is
the answer) is non-empty, the human-answer block. A second park before the
same seed reports `resumeSeed: true` again. Every other park reports
`false`, and the field is ignored on an answer resume. Without this, a
spent node's answer resume that was paused before its seed would be
refused on the unpause and end `budget_exhausted`.

The alternative was not to consult the hook for a resume's seed at all.
That is simpler, but a pause landing just as an answered or quota-requeued
job is claimed would then wait out the whole seed node, which can be most
of a two-hour node cap, against spec scenario (e).

### 5. Edge counts travel with the park

`parked.edgeTraversals` carries the run's counts, keyed
`<from>-><to>:<when>`. That was an internal key format until now (it was
`from|to|when`). The `:<when>` is always present, because two edges
between one pair can differ only by `when`. `ResumeState.edgeTraversals`
seeds the counters, using the same rehydration rules as `iterations`:
keys naming no declared edge and negative or non-finite counts are
ignored, and counts are truncated. The seed still traverses no edge.
A run parked and resumed any number of times therefore traverses a
bounded edge no more often than one uninterrupted run (spec D4).

The counts are honoured on any resume that supplies them. An answer
resume that does not supply them keeps 0042's fresh budget, which spec D4
keeps for answered asks.

## Consequences

- No hook and no new resume field: the run is identical. Tests pin it.
- `RunStatus` gains `parked`. A caller that switches exhaustively on it
  needs a case. minifac's own CLI and `serve` supply no hook and never see
  it, but they accept a `parked` row from a shared store. `prune
  --outputs` classifies a parked run past the age cutoff as unmerged-old,
  which it removes only with `--all`, so a parked run's outputs are not
  pruned by default.
- The resume contract a caller must keep: hand back `iterations` and
  `priorResults` that do NOT count the parked dispatch (the store does
  this already, per §1), so the seed is numbered `parked.iteration`; and
  hand back `parked.edgeTraversals` and `parked.resumeSeed` as the
  matching `ResumeState` fields. A caller that drops `resumeSeed` gets a
  pause resume that refuses a spent answer seed.

## Rejected alternatives

- **Reuse `abortSignal`.** It either reports no node or kills the node in
  flight (see Context).
- **Consult the hook before admission.** A park could then record a
  dispatch the budget would refuse, and the resume would need an
  exemption to make it, or fail right after the unpause.
- **`status: "failed", reason: "parked"`.** The spec says a park is not a
  failure. Every caller that treats `failed` as failure (retry budgets,
  asks) would have to special-case one reason.
- **Mark a pause resume as an answer and add a `run.resume_reason`
  token.** Every gate would have to check it, and one written before it
  existed would read a pause as an approval (spec D3).
- **Persist edge counts in `runs.db`.** Scarif's EC2 lane loses `runs.db`
  with the instance, so the counts must travel with the park anyway.

## Amends

- [`0042-Resume-At-Node`](0042-Resume-At-Node.md) §1 (the exemption is
  answer-only) and §2 (edge counters start from supplied counts).
- [`0043-Follow-Up-And-Resumed-At`](0043-Follow-Up-And-Resumed-At.md)
  (`run.resumed_at` on a pause resume).

## Related

- [[Run]]
- [[Runner]]
- scarif-spec `openspec/changes/factory-pause-at-node-boundary`
