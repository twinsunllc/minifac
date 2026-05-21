---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0025: Upgrade vitest 2.x → 3.x

## Context

The nightly `npm audit` flags 5 moderate-severity vulnerabilities,
all in the `vitest@2.x → vite → esbuild` dev chain. None are
exploitable from production code paths (dev-only), and our
gating audit (`--audit-level=high`) doesn't fail on them. But:

- Treating dev-deps as "less important" was exactly the false
  premise that produced the nx postinstall worm and several
  recent supply-chain incidents. The `nightly` audit highlights
  these every day; they should be **resolved**, not normalized.
- The fix path is non-controversial: vitest 3 was released
  ~6 months ago, has a stable plugin API, and brings vite to a
  patched version that closes the chain.
- We're about to publicize the repo. A "5 moderate, see #N" badge
  on the security tab is a worse first impression than the
  10 minutes of upgrade work.

## Decision

Upgrade `vitest` to `^3.x` (and `ink-testing-library` if it pins
older vitest). Track-down + fix any test breakage from vitest 3's
behavior changes. Accept the new pool-default (`threads`) unless
profiling reveals an issue.

### Known breaking changes to watch for

From [vitest 3 release
notes](https://github.com/vitest-dev/vitest/releases/tag/v3.0.0):

- Default pool changed from `forks` to `threads`. Tests that
  rely on per-test process isolation may regress; if so, set
  `pool: 'forks'` in `vitest.config.ts`.
- `vi.mock` factory return shape: must explicitly return a value;
  implicit `undefined` no longer accepted.
- `expect.soft` API tightened — error messages change.
- Reporter output format changes — affects CI log scrapers (we
  don't have any).
- Node 18 support dropped — we're on 22+, no impact.

### What to do

1. Bump `vitest` to `^3.x` in `devDependencies`. Run `npm install`
   to refresh `package-lock.json`.
2. Bump `ink-testing-library` if it pins an older vitest range.
3. Run `npm test`; triage any failures. Most likely the `vi.mock`
   factory return changes; map them mechanically.
4. Run `npm run check:dep-freshness` to verify the new lockfile
   passes the cooldown gate (vitest 3.x patch releases are
   typically > 3 days old; if a fresh patch lands the day we
   run, pin to the prior patch).
5. Run `npm audit`; confirm the 5 moderate findings are gone (or
   replaced with a smaller set; investigate any residual).
6. Run `npm run build`, `npm run check`. Ship.

## Consequences

- One less daily-noise item on the security tab.
- Vitest 3 has been generally well-received; minor ergonomics
  wins (better watch mode, faster startup with `threads` pool).
- Slim risk a test relies on per-test process isolation — easy
  rollback to `pool: 'forks'` in config.

## Alternatives considered

- **Pin vitest@2.x indefinitely with `audit allowlist`.** Hides
  the signal; doesn't fix the underlying chain. Rejected.
- **Wait until vitest 4.** No timeline. Today's chain is fixable
  today. Rejected.
- **Replace vitest with node:test.** Bigger lift; tooling
  ecosystem around vitest (snapshot, ink-testing-library
  integration) is real. Not worth it for the audit issue alone.

## Related

- [[0024-CI-Security-Policy]] — frames dev-deps as in-scope
- The nightly `security.yml` workflow that currently flags this
