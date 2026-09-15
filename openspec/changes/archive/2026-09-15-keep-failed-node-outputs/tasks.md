## 1. Runner

- [x] 1.1 In `src/runner/run.ts`, run `validateDeclaredOutputs` on a
      `failed` node that declares `outputs:`; index what is present,
      preserve the reason, never nudge or override; emit an
      `outputs_warning` stderr line (plus per-key detail) when a
      `required` key is unsatisfied
- [x] 1.2 On the succeeded path, carry the present-and-satisfied index on
      the `priorResults` entry whether or not the
      `missing_required_output` override fires
- [x] 1.3 In `src/runner/substitute.ts`, resolve
      `{{ priorResults.<id>.status }}` and `{{ priorResults.<id>.reason }}`
      (`""` for no prior result / null reason)

## 2. Tests

- [x] 2.1 Sentinel-failed node with a parseable `results.json`: reason
      preserved, `priorResults` entry carries `outputs.results`, store
      records the index
- [x] 2.2 Sentinel-failed node missing a required output: `outputs`
      null, reason preserved, `outputs_warning` stderr event emitted, no
      `missing_required_output`
- [x] 2.3 Missing-required override carries the partial index on the
      `priorResults` snapshot
- [x] 2.4 `on_failure` target reads the failed node's output via
      `:read` and its `status` / `reason` tokens
- [x] 2.5 Unit tests for the two new tokens, including pass-through via a
      `uses:` node's inputs
- [x] 2.6 Integration: evaluate fails with `verdict: revise`; implement
      (reached by `on_failure`) receives the findings inline

## 3. Docs

- [x] 3.1 ADR 0041 (with `carries:` considered and deferred)
- [x] 3.2 `docs/concepts/Outputs.md`, `Factory.md`, `Runner.md`

## 4. Verify

- [x] 4.1 `npx tsc --noEmit`, `npx biome check .`, `npx vitest run`,
      `npx openspec validate --all --strict`
