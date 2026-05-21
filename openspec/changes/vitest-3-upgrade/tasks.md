## 1. Bump dependencies

- [x] 1.1 `npm install --save-dev vitest@^3 ink-testing-library@latest`
- [x] 1.2 Confirm `package-lock.json` resolves cleanly; if
      `ink-testing-library@latest` rejects vitest 3 via peer
      range, pin to the highest `ink-testing-library` version
      that accepts vitest 3.x and rerun the install
- [x] 1.3 Inspect the diff on `package.json` —
      `devDependencies.vitest` is `^3.x` and
      `devDependencies.ink-testing-library` is on a release
      that accepts vitest 3

## 2. Land the suite on green

- [x] 2.1 `npm test` — capture any failures
- [x] 2.2 For each `vi.mock` factory failure, add the explicit
      `return {}` (or appropriate stub) the factory needs;
      avoid changing test semantics beyond the return shape
      (no factory failures encountered)
- [x] 2.3 For each snapshot failure, eyeball the diff;
      `npm test -- -u` only after confirming the shift is
      cosmetic (whitespace, trailing newline, reporter
      formatting), never to paper over a content regression
      (no snapshot failures encountered)
- [x] 2.4 For each pool-isolation failure, prefer repairing the
      test to clean up per-process state; if a repair is
      infeasible, opt that one suite into `pool: 'forks'` via
      a targeted `poolMatchGlobs` (or equivalent) entry in
      `vitest.config.ts`, with a comment naming the
      per-process state that justifies the opt-out
      (no pool-isolation failures encountered)
- [x] 2.5 Re-run `npm test` until all 585+ tests pass
      (623/623 passed first run)

## 3. Verify security + freshness gates

- [x] 3.1 `npm audit` — confirm the 5 prior moderates in the
      vitest/vite/esbuild chain are cleared; if a strict
      subset remains, list the residual CVEs (id + brief
      summary) in the apply commit message
      (0 vulnerabilities — all 5 moderates cleared)
- [x] 3.2 `npm run check:dep-freshness` — must pass; if the
      newest vitest patch is < 3 days old at apply time, pin
      to the prior patch in `package.json` and rerun
      (157 deps all ≥ 3 days old)

## 4. Verify the rest of CI

- [x] 4.1 `npm run check` (biome) — clean, no-op expected
      (npm install reformatted `files` array; ran `npm run
      format` to restore biome-canonical layout)
- [x] 4.2 `npm run build` — clean
- [x] 4.3 Confirm no README/CONTRIBUTING change is needed
      (none expected; the new `testing` spec is the durable
      record)

## 5. Land the spec

- [x] 5.1 Move the new `testing` capability spec into
      `openspec/specs/testing/spec.md` at archive time (the
      change's `specs/testing/spec.md` is the source of
      truth until then)
      (deferred to archive step 6.2; spec lives at
      `openspec/changes/vitest-3-upgrade/specs/testing/spec.md`
      until then)
- [x] 5.2 Confirm `openspec validate vitest-3-upgrade --type
      change` exits 0

## 6. Commit + archive

- [ ] 6.1 Apply commit names any audit residuals and the
      vitest patch version that landed
- [ ] 6.2 `/opsx:archive vitest-3-upgrade`
