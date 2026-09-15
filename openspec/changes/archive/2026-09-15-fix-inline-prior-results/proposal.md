## Why

A `{{ priorResults.<node>.outputs.<key>[:read] }}` token passed through a
`uses:` node's `inputs:` is erased to the empty string at load time
(issue #33; scarif-factory FINDINGS F2). Step inlining calls
`substitute(v, { inputs })` to fold `{{ inputs.* }}` into the step body;
the first pass makes the priorResults token visible, and the second pass
runs the prior-results substitution against an absent map, whose
"not found" rule substitutes `""`. By the time the runner dispatches the
node there is no token left to resolve.

Inline nodes are unaffected, so the defect only bites the portable form
— which is exactly the form a shared library step needs if it is to
take a predecessor's output as a typed, load-checked input instead of
scraping the prior-results preamble by node id.

## What Changes

- **FIXED** inline-time substitution resolves `{{ inputs.* }}` tokens
  only. Every other token — `brief.*`, `run.*`, `priorResults.*`,
  unknown namespaces — survives into the inlined step body verbatim for
  dispatch-time resolution, including a token an input value carries in.
  Implemented as a dedicated `substituteInputs()` in
  `src/runner/substitute.ts` used by `src/step/inline.ts`; dispatch-time
  `substitute()` is unchanged.
- **MODIFIED** `factory-schema` "Step input validation" requirement: the
  "Templated input values" rule now names `priorResults` tokens alongside
  `brief` / `run`, states that load-time substitution touches `inputs.*`
  only, and gains a scenario for the pass-through case.

No schema, CLI, or runs.db change. No behavior change for inline nodes
or for `uses:` nodes whose inputs carry no priorResults token.

## Impact

- `src/runner/substitute.ts`, `src/step/inline.ts`
- Tests: `src/step/inline.test.ts`, `src/runner/substitute.test.ts`,
  `src/runner/outputs-integration.test.ts` (load-from-disk → run →
  reader receives the writer's output through a step input)
