## Context

Every dispatch already has an `iteration` (outputs dir, store row, event
tags). Edge traversal counts live in the runner's `edgeTraversals` map,
keyed `<from>-><to>:<when>` (ADR 0048), but nothing remembers which edge
queued a given dispatch.

## Decisions

1. **The queue item carries its entering edge.** When an edge is
   traversed the runner pushes `{ nodeId, via: { key, traversals,
   maxTraversals } }`, with `traversals` the count after this traversal.
   Reading the live map at dispatch instead would be wrong when the same
   edge is traversed again before the item is dispatched.
2. **No edge renders `0` / empty, not verbatim.** A start node and a
   resume seed with no `via` are real "first entry" cases a prompt should
   be able to test, the same reasoning as `run.feedback`.
3. **Unknown fields stay verbatim, no error.** That is what an unknown
   `brief.*` or `run.*` field does today; a hard error would be a new,
   inconsistent contract.
4. **Park and resume.** `ParkedRun.via` (and `pending[].via`) name the
   parked item's edge key; `ResumeState.via` hands it back. The seed
   rebuilds `traversals` from the rehydrated `edgeTraversals` (the seed
   traverses no edge, so the count is not incremented) and the budget
   from the factory. A `via` that is not a declared edge into `at` is
   ignored.
5. **CLI answer resume renders `0` / empty for `edge.*`.** runs.db does
   not record the entering edge; recording it would need a migration and
   is out of scope. `node.iteration` is still correct there.

## Alternatives rejected

- Counting at dispatch time from the live map (see 1).
- A separate `cycle.*` namespace: the edge is what carries the budget.
- Erroring on unknown fields (see 3).
