## Why

Scarif's split-into-subtasks change (scarif-spec
`openspec/changes/split-into-subtasks`, scarif-spec#207, 197d15bc)
splits a large plan into child factory jobs, each on the parent's
branch, and later resumes the parent for integration. A factory's pause
gate has to tell a child from an ordinary job, or a child re-parks at
its own gate, which is the loop a split exists to break (its design.md
decision 8). Task 4.1 asks minifac to expose `run.split` and
`run.split_integration` to node templates and the node preamble, the way
ADR 0043 exposed `run.follow_up` (SCARIFW-1493).

## What Changes

- **ADDED** `graph-runner` "Split run-context tokens and preamble
  block": `RunOptions.split` and `RunOptions.splitIntegration`, the
  tokens `{{ run.split[.<key>...] }}` and
  `{{ run.split_integration[.<key>...] }}`, and a run-context block
  prepended to every prompt of a split child or resumed split parent.
- The simple token grammar gains an optional dotted sub-path, which
  resolves only under these two tokens.

## Impact

- Affected specs: `graph-runner`
- Affected code: `src/runner/run.ts`, `src/runner/substitute.ts`,
  `src/runner/resume.ts`, `src/index.ts`
- No breaking change. Without the new options, `{{ run.split }}` and
  `{{ run.split_integration }}` render `null` and their sub-paths the
  empty string; before this change they passed through verbatim.
  Prompts of runs without the options are unchanged.
