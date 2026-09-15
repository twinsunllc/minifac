## 1. Fix

- [x] 1.1 Add `substituteInputs(input, inputs)` to `src/runner/substitute.ts`:
      resolves `{{ inputs.* }}` only (two passes, matching `substitute`),
      leaves every other namespace verbatim
- [x] 1.2 Use it in `src/step/inline.ts` in place of
      `substitute(v, { inputs })`

## 2. Tests

- [x] 2.1 Unit: inlining a step whose inputs carry `priorResults` tokens
      (plain and `:read`) leaves them verbatim in the inlined prompt
- [x] 2.2 Unit: `substituteInputs` resolves nested inputs tokens and
      leaves brief / run / priorResults / unknown namespaces verbatim
- [x] 2.3 Integration: load a factory from disk whose `uses:` node takes
      `{{ priorResults.writer.outputs.findings:read }}` as an input, run
      it, and assert the reader's dispatched prompt carries the writer's
      output
- [x] 2.4 Confirm 2.1 and 2.3 fail against the unfixed `inline.ts`

## 3. Verify

- [x] 3.1 `npm run typecheck`, `npm run check`, `npm test`,
      `openspec validate --all --strict`
