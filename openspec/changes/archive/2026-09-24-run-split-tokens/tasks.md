## 1. Runner

- [x] 1.1 `src/runner/resume.ts`: `SplitState`, `SplitIntegrationState`,
      `SPLIT_CHILD_HEADING`, `SPLIT_INTEGRATION_HEADING`,
      `splitContextBlock`
- [x] 1.2 `src/runner/run.ts`: `RunOptions.split` /
      `RunOptions.splitIntegration`; set `run.split` /
      `run.split_integration` (null when absent) on every run; prepend
      the block to prompt-bearing dispatches of a split run
- [x] 1.3 `src/runner/substitute.ts`: the optional dotted sub-path, its
      resolution under the two tokens, and verbatim for every other
      dotted token, including in `substituteInputs`
- [x] 1.4 `src/index.ts`: export the types and headings

## 2. Tests

- [x] 2.1 `substitute.test.ts`: fields, JSON, none-values, unknown keys,
      `split_integration`, other dotted tokens verbatim,
      `substituteInputs`
- [x] 2.2 `run.resume.test.ts`: a child run gets the tokens and the
      block; an ordinary run gets neither; a resumed split parent gets
      the integration block and the human-answer block; a prompt-less
      node is unchanged

## 3. Docs

- [x] 3.1 ADR 0044
- [x] 3.2 CHANGELOG
- [x] 3.3 Fold the delta into `openspec/specs/graph-runner/spec.md`, and
      name the sub-path in the "Brief token substitution before node
      dispatch" grammar
