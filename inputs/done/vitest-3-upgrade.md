---
change: vitest-3-upgrade
factory: sdd
base_branch: main
---

## Background

Nightly `npm audit` shows 5 moderate-severity findings, all in
the `vitest 2.x → vite → esbuild` dev chain. With
`docs/decisions/0024-CI-Security-Policy.md` framing dev deps as
in-scope for supply-chain hygiene (and us shipping the
publicly-visible security tab soon), it's time to clear them.

The binding decision is at
`docs/decisions/0025-Vitest-3-Upgrade.md`. Read it first. Key
calls already locked there:

- Upgrade `vitest` to `^3.x`. Accept the new default `threads`
  pool unless tests demand `forks` for isolation.
- Also bump `ink-testing-library` if it pins older vitest.
- Don't change application code or test semantics beyond what
  vitest 3's API requires.

## What to do

### 1. Bump

- `npm install --save-dev vitest@^3 ink-testing-library@latest`
- Confirm `package-lock.json` resolves cleanly. If
  `ink-testing-library` is incompatible (peer range too tight),
  prefer the newest compatible vitest version it accepts.

### 2. Run the suite

- `npm test` — full vitest run
- If failures fall into recognizable buckets, fix mechanically:
  - **`vi.mock` factory return shape**: factories must return a
    value explicitly; add `return {}` (or appropriate stub)
    where missing.
  - **Pool-isolation regressions**: if a test relies on per-test
    process state (e.g., `process.cwd` mutations), it may flake
    under `threads`. Either repair the test to clean up state, or
    set `pool: 'forks'` in `vitest.config.ts` (preferred only as a
    targeted opt-out, not a global rollback).
  - **Snapshot updates**: ink-testing-library's render output
    may shift slightly with vitest 3's reporter. Update
    snapshots with `npm test -- -u` after manually confirming
    the new output is correct (not a regression).

### 3. Audit + freshness gates

- `npm audit` — the prior 5 moderates should be cleared (or
  reduced to a non-empty smaller set; if so, document residuals
  in the apply commit message).
- `npm run check:dep-freshness` — must pass. If the bumped
  vitest patch happens to be < 3 days old at run time, pin to
  the prior patch.

### 4. Tidy

- `npm run check` (biome) — should be no-op
- `npm run build` — must pass
- README or CONTRIBUTING — no change expected
- Specs — no change expected (vitest is a test-runner, not a
  product behavior)

### 5. Spec change

If a `dev-environment` or `testing` spec exists, MODIFY the
applicable requirement to mention vitest 3 minimum. If no such
spec exists, this is a dependency-only bump and no spec change
is needed.

## Out of scope

- Migrating to `node:test`
- Snapshot serializer customization beyond what vitest 3
  defaults give us
- Adopting vitest workspaces (we don't have a monorepo)

## Acceptance criteria

- `vitest` upgraded to `^3.x`; `package.json` reflects the bump
- `package-lock.json` refreshed
- `npm test` passes (all 585+ tests green)
- `npm run check:dep-freshness` passes
- `npm audit` no longer reports the prior 5 moderates from the
  vitest/vite/esbuild chain (or only a strict subset, with the
  residuals named in the apply commit)
- `npm run check` and `npm run build` clean
