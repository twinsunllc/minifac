---
status: accepted
date: 2026-10-17
supersedes: []
superseded-by: null
tags: [decision]
---

# 0050: `node.iteration` and `edge.*` template tokens

## Context

A step inside a revise loop often needs to know which pass it is on and
how many passes the loop allows. Today it counts its own earlier entries
in its preamble, and a factory passes a `max_cycles` input that someone
has to keep equal to the loop edge's `max_traversals` by hand
(scarif-factory FINDINGS F11; minifac#42, SCARIFW-2249). The [[Runner]]
already holds both numbers when it dispatches.

## Decision

- Two more template namespaces, resolved at dispatch in the same pass as
  `brief.*`, `run.*` and `inputs.*`, on the same fields (`with.prompt`,
  `with.base`, `cwd`):
  - `{{ node.iteration }}` — the dispatch's 1-based iteration, the number
    its outputs directory, store row and events carry (Scarif's worker
    tags its log lines `[node:<id>#<n>]` with it).
  - `{{ edge.traversals }}` — the traversal count of the edge that queued
    this dispatch, counting the traversal that queued it.
  - `{{ edge.max_traversals }}` — that edge's budget.
- No entering edge (a start node, a resume seed with no `via`) renders
  `0` and the empty string; an edge with no budget renders the empty
  string. These are real answers ("first entry", "no budget") a prompt
  can test, the reasoning [[0042-Resume-At-Node]] used for
  `run.feedback`.
- The count is captured when the edge is traversed and travels with the
  queued dispatch, so a second traversal of the same edge before the
  dispatch runs does not change what it renders.
- Unknown fields (`{{ node.foo }}`, `{{ edge.bar }}`) and dotted
  sub-paths pass through verbatim with no error, as unknown `brief.*`
  and `run.*` fields do.
- Load-time step inlining leaves the tokens alone, so they work inside a
  `uses:` node's `inputs:` bindings.
- A park ([[0048-Park-At-Node-Boundary]]) records the parked dispatch's
  entering edge as `ParkedRun.via`; `ResumeState.via` hands it back, and
  the seed renders that edge's rehydrated count and budget. A `via` that
  is not a declared edge into the seed is ignored.
- A resume rebuilt from runs.db (`minifac run --resume --at`) has no
  `via`: runs.db does not record entering edges. Its seed renders `0` /
  empty for `edge.*`; `node.iteration` is still the iteration it would
  have had.

## Rejected alternatives

- **Read the live traversal map at dispatch.** Wrong when the same edge
  is traversed again before the queued dispatch runs.
- **A `cycle.*` namespace.** The budget belongs to an edge; a node can
  sit on more than one cycle, so "the cycle" is not well defined.
- **Fail the run on an unknown field.** No other namespace does; one
  that did would be a second, inconsistent contract.
- **Record the entering edge in runs.db.** Needs a migration for a CLI
  answer-resume nicety; deferred until a caller needs it.

## Consequences

- A factory can drop a hand-kept `max_cycles` input and bind
  `{{ edge.max_traversals }}` instead.
- A caller that pauses and resumes runs (Scarif's worker) must pass
  `ParkedRun.via` back as `ResumeState.via` for `edge.*` to survive a
  pause; without it the resumed seed renders `0` / empty.
- A command executor that resolves its command string through
  `substitute()` inherits the tokens.
