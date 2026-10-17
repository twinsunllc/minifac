## Why

A looping step that needs its cycle number counts earlier entries in its
own preamble, and a `max_cycles` input has to be kept equal to the loop
edge's `max_traversals` by hand (scarif-factory FINDINGS F11;
twinsunllc/minifac#42, SCARIFW-2249). The runner already knows both
numbers at dispatch.

## What Changes

- **ADDED** `graph-runner` "Node iteration and entering-edge tokens":
  `{{ node.iteration }}`, `{{ edge.traversals }}` and
  `{{ edge.max_traversals }}` resolve at dispatch wherever the existing
  namespaces do (`with.prompt`, `with.base`, `cwd`, and `inputs:` bindings
  inlined into them). No entering edge renders `0` and the empty string.
  Unknown fields stay verbatim.
- `ParkedRun.via` and `ResumeState.via` carry the entering edge across a
  pause, so a resumed dispatch renders the counts it would have had.
- The namespace lists in "Brief token substitution before node dispatch",
  the `ResumeState` shape in "Resumed runs" and the park payload in
  "Between-node boundary hook and park" are updated in place to name the
  additions.

## Impact

- `src/runner/substitute.ts`, `src/runner/run.ts`, `src/runner/result.ts`,
  `src/runner/resume.ts`.
- Additive: no runs.db change. A factory whose prompt already held the
  literal text `{{ node.iteration }}` now sees it rendered.
- Command strings: the command executor (SCARIFW-2244 story 1) has not
  landed; it inherits the tokens if it resolves through `substitute()`.
