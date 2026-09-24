---
status: accepted
date: 2026-09-24
supersedes: []
superseded-by: null
tags: [decision]
---

# 0044: Tell a node it is a split child, or a split parent integrating

## Context

Scarif's split-into-subtasks change (scarif-spec
`openspec/changes/split-into-subtasks`, scarif-spec#207) turns one large
plan into child factory jobs, each cut from and merging into the parent's
branch, and then resumes the parent at `implement` to integrate them.
Its design decision 8 ("A child knows it is a child") needs a factory's
pause gate to tell a child from an ordinary job: a child sized 1 whose
plan comes out `medium` would otherwise re-park at its own gate, which
is the loop a split exists to break. Its task 4.1 asks minifac to expose
`run.split` and `run.split_integration` to node templates and to the node
preamble, the way [`0043`](0043-Follow-Up-And-Resumed-At.md) exposed
`run.follow_up` (SCARIFW-1493).

## Decision

- `RunOptions.split` (`{parent_work_item_id, parent_jira_key,
  parent_branch, child_index, child_count, group}`, `child_index`
  1-based) marks a split child. `RunOptions.splitIntegration`
  (`{children, unmerged_sub_tasks}`) marks a resumed split parent. Both
  are snake_case, as the claim's `factory.split` carries them, and both
  are opaque to the runner. Neither changes the start nodes or the
  resume seeding.
- `{{ run.split }}` and `{{ run.split_integration }}` render the object
  as JSON, or `null` when absent.
- The token grammar gains an optional dotted sub-path, which resolves
  only under these two: `{{ run.split.parent_branch }}` renders a string
  as-is, a number or boolean via `String`, and an object or array as
  JSON. A missing key, a null value, an absent object, or a step through
  an array or scalar renders the empty string (the `run.feedback`
  convention). Every other dotted token, in any namespace, passes
  through verbatim, as it did before.
- For a split child or a resumed split parent, every dispatch with a
  string `with.prompt` gets a run-context block prepended:
  `## Split child (run.split)` and/or
  `## Split integration (run.split_integration)`, each with the object
  as fenced JSON. A resume seed's `## Human answer (resume)` block is
  still appended after the prompt. A run with neither option gets no
  block, so its prompts are what they were before this change.

## Consequences

- Nothing reaches a real run until Scarif sends `factory.split` in the
  claim and the worker passes it to `RunOptions.split`. When the worker
  bumps its minifac pin for that, the pin must be minifac `main`'s merge
  commit, never a PR branch head (the SCARIFW-1469 lesson,
  scarif-worker#467).
- What a gate does with `run.split` is the owning factory's decision.
- `run.follow_up` is token-only; `run.split` also has a prompt block.
  The scarif-spec change says "as it does `run.follow_up`" for both
  channels; this is the one place the two differ.

## Alternatives considered

- **A general dotted-path grammar for every namespace.** It would change
  what `{{ brief.x.y }}` and `{{ inputs.a.b }}` render, today verbatim,
  for no current need.
- **Put the context in the claude executor's `priorResults` stdin
  preamble.** That changes a wire format the node-executor spec pins
  and a consumer mirrors, and it would reach only one executor.
- **Tokens only, like `run.follow_up`.** The change asks for the
  preamble too, and a block reaches a node whose step does not bind the
  token.
- **Array indexing (`run.split.group.0.title`).** A prompt reads
  `{{ run.split.group }}` as JSON, which is enough for a gate.

## Related
- [[Run]]
- [`0042-Resume-At-Node`](0042-Resume-At-Node.md)
- [`0043-Follow-Up-And-Resumed-At`](0043-Follow-Up-And-Resumed-At.md)
