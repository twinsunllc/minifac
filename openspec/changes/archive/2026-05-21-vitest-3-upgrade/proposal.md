## Why

Nightly `npm audit` reports 5 moderate-severity findings, all in
the `vitest@2.x → vite → esbuild` dev chain. With
[[0024-CI-Security-Policy]] treating dev deps as in-scope for
supply-chain hygiene and the repo about to flip its security tab
public, the chain needs to be cleared rather than allowlisted.
[[0025-Vitest-3-Upgrade]] locks the decision; this change executes
it.

## What Changes

- **BUMP** `vitest` from `^2.x` to `^3.x` in `devDependencies`,
  pulling in the patched `vite`/`esbuild` chain that clears the
  audit findings.
- **BUMP** `ink-testing-library` to the newest release that
  permits vitest 3 as a peer (currently this is the latest
  published version; if the peer range is too tight, pin to the
  most recent vitest 3.x release it does accept).
- **ACCEPT** vitest 3's new default `threads` pool. Do not switch
  back to `forks` globally; only adopt `pool: 'forks'` as a
  targeted opt-out if a specific suite cannot be repaired.
- **MECHANICAL TEST REPAIRS** for vitest 3's two known
  hard-failure modes:
  - `vi.mock` factories must explicitly `return` a value (no
    implicit `undefined`).
  - Snapshot output may shift slightly under the new reporter;
    update snapshots after eyeball-confirming the diff is
    cosmetic, not a regression.
- **NEW** `testing` capability spec documenting the vitest 3
  baseline and the pool-default policy so future bumps and
  rollbacks have a written contract to point at.
- **NO** application code or test-semantics changes beyond what
  vitest 3 requires.

## Capabilities

### New Capabilities

- `testing`: documents which test runner the repo uses, the
  minimum supported major, and the pool-isolation default. Lives
  as `openspec/specs/testing/spec.md`. Records the vitest 3 floor
  plus the `threads`-default-with-targeted-`forks`-opt-out policy
  so the next bump or pool flip has a written contract.

### Modified Capabilities

<!-- None. No product-facing capability changes; this is dev-chain
     hygiene plus a new policy spec. -->

## Impact

- **Dependencies:** `package.json` (`vitest`, `ink-testing-library`),
  `package-lock.json` refresh.
- **Tests:** possible `vi.mock` factory fixups; possible snapshot
  refresh; possible targeted `pool: 'forks'` on a suite that
  mutates per-process state (e.g. `process.cwd`). All 585+ tests
  must remain green.
- **Config:** `vitest.config.ts` may gain a `pool` opt-out for one
  or two suites; no global pool change.
- **Audit:** the prior 5 moderate findings in the
  vitest/vite/esbuild chain are cleared (or strictly reduced; any
  residual is named in the apply commit message).
- **Freshness gate:** `npm run check:dep-freshness` must pass; if
  the newest vitest patch is < 3 days old at apply time, pin to
  the prior patch.
- **CI:** `npm run check`, `npm run build`, `npm test`, and
  `npm run check:dep-freshness` all clean.
- **Docs:** no README/CONTRIBUTING change expected; the new
  `testing` spec is the durable record.
- **Out of scope** (named so future bumps don't reopen them):
  migrating to `node:test`, customizing snapshot serializers
  beyond vitest 3 defaults, adopting vitest workspaces.
