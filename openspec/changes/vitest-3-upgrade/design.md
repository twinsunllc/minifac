## Context

The repo is on `vitest@^2.x`. Nightly `npm audit` reports 5
moderate-severity findings, all transitively in
`vitest → vite → esbuild`. None are reachable from production
code paths (vitest is `devDependencies`-only) and the gating
audit level (`--audit-level=high`) does not fail on them, but the
findings sit on the security tab forever and the
[[0024-CI-Security-Policy]] decision explicitly puts dev-chain
hygiene in scope.

[[0025-Vitest-3-Upgrade]] is the binding ADR. The decision is
already taken — vitest 3 is ~6 months old, has a stable plugin
API, and brings vite to a version that closes the audit chain.
This change exists to execute the bump and to capture the policy
in a spec so future bumps and rollbacks have something to point
at.

Current scale: 585+ tests across the suite. The CLI uses
`ink-testing-library` for TUI snapshots, which pins a vitest peer
range. Vitest 3 ships two behavior changes that can break tests
mechanically — the `vi.mock` factory return shape and the default
pool flip from `forks` to `threads`.

## Goals / Non-Goals

**Goals:**

- Clear the 5 moderate audit findings in the
  vitest/vite/esbuild chain.
- Land vitest 3 on `^3.x` so future minor/patch bumps flow in
  via the normal cooldown gate.
- Keep the test suite green with the minimum mechanical fixups
  vitest 3 requires.
- Record the test-runner baseline (engine, major floor, pool
  policy) in a `testing` capability spec so the next bump is
  not archaeology.

**Non-Goals:**

- Migrating any tests off vitest (e.g. to `node:test`).
- Customizing snapshot serializers beyond vitest 3 defaults.
- Adopting vitest workspaces — we are not a monorepo.
- Refactoring tests that already pass under the new pool.
- Rewriting `vi.mock` factories beyond the mechanical
  `return {}` (or appropriate stub) needed to satisfy vitest 3.
- Touching application code or test semantics.

## Decisions

### Decision 1: Bump to `^3.x`, not pinned exact version

**Choice:** `npm install --save-dev vitest@^3` so the lockfile
captures the latest 3.x patch, and the `package.json` range
admits future 3.x bumps via the normal cooldown gate.

**Rationale:** vitest 3 was released ~6 months ago and patch
releases have been steady. Pinning exact would cost us free
security fixes and bind us to a specific patch with no upside.
The 3-day dep-freshness gate
([[0023-Dep-Freshness-Cooldown]]) already protects against
brand-new patches.

**Alternative considered:** Pin a specific patch (e.g.
`3.x.y` exact). Rejected — it just defers the next bump
without buying isolation.

### Decision 2: Accept the `threads` pool default

**Choice:** Take vitest 3's new default of `pool: 'threads'`
across the suite. Do not set a global `pool: 'forks'` rollback
in `vitest.config.ts`.

**Rationale:** `threads` is faster on the suite sizes we have
and is the upstream-supported default. Setting a global rollback
silently keeps us on a pool the upstream will eventually
deprecate. If a specific suite mutates per-process state
(`process.cwd`, `process.env`, module-level singletons), repair
the suite to clean up between tests; only fall back to
`pool: 'forks'` for that one suite if the repair is infeasible.

**Alternative considered:** Set `pool: 'forks'` globally to
"avoid risk." Rejected — invisible regression on suite startup
time, and it papers over real test-isolation bugs that would
bite us under any future runner.

### Decision 3: Land a `testing` capability spec, not a docs note

**Choice:** Create a new `testing` capability spec recording the
runner choice (vitest), the minimum major (`>= 3`), and the pool
policy (`threads` default, targeted `forks` opt-out only).

**Rationale:** ADRs are decisions; specs are contracts. The next
time someone proposes a vitest 4 bump, a pool flip, or a runner
swap, they should have something concrete to MODIFY rather than
re-deriving the policy from `package.json` and a git log of
ADRs. This is also the minimum we need to satisfy OpenSpec
validation, but it earns its keep beyond that.

**Alternative considered:** Skip the spec — the ADR is enough,
and `package.json` is the source of truth for the version.
Rejected — `package.json` records the floor but not the *policy*
(the pool-default reasoning, the "no global forks rollback"
rule), and the ADR log is not a contract specs can MODIFY in a
later change.

### Decision 4: Bump `ink-testing-library` mechanically, fall back if peer range blocks

**Choice:** Run `npm install --save-dev ink-testing-library@latest`
alongside the vitest bump. If npm reports a peer-dependency
conflict (e.g. `ink-testing-library` pins
`vitest@^2`), pin to the most recent vitest 3.x release the
library accepts.

**Rationale:** The library is small, peer-coupled, and
well-maintained; latest will almost certainly already permit
vitest 3. If not, we degrade gracefully: stay on 3.x but on the
patch the peer allows, rather than holding the whole bump
hostage to a transitive pin.

**Alternative considered:** Replace `ink-testing-library` with
a hand-rolled snapshot helper. Rejected — overshoots the audit
fix and adds a maintenance surface we don't need.

## Risks / Trade-offs

- **[Hidden test that relied on per-test process isolation]** →
  Repair the test to clean up state explicitly (push/pop
  `process.cwd`, `process.env`, etc.). If the repair is more
  than a few lines, set `pool: 'forks'` on *that one suite* via
  `vitest.config.ts` `poolMatchGlobs` (or equivalent). Do not
  flip globally.
- **[`vi.mock` factory shape changes ripple wider than expected]**
  → Map mechanically: every factory that previously fell through
  to implicit `undefined` gets an explicit `return {}` (or the
  stub the test actually wants). If a factory was relying on
  implicit-`undefined` semantics for behavior (not just
  shape), call that out in the apply commit; it is a latent bug
  the vitest 3 stricter shape caught.
- **[Snapshot output for ink-testing-library shifts cosmetically]**
  → Eyeball-diff the snapshot delta. If only whitespace or
  trailing-newline shifts, `npm test -- -u` and commit. If
  content shifted, that is a regression and the bump is blocked
  until the snapshot diff is explained.
- **[New vitest patch is < 3 days old at apply time]** →
  Dep-freshness gate blocks the bump. Pin to the prior patch
  (`vitest@3.x.y-1`) in `package.json` and re-run. Do not
  bypass the gate.
- **[Audit residuals after the bump]** → If `npm audit` still
  reports findings on the vitest/vite/esbuild chain after the
  bump, document the residual CVEs (number + brief summary) in
  the apply commit message rather than silently absorbing them.
  Quiet downgrades of the success bar are how supply-chain
  vigilance erodes.
- **[Rollback]** → Revert the commit. Lockfile and `package.json`
  return to vitest 2.x; no schema or data migration to undo.

## Migration Plan

1. `npm install --save-dev vitest@^3 ink-testing-library@latest`
2. `npm test` — fix mechanical breakage (`vi.mock` factories,
   snapshots, targeted `pool: 'forks'` if needed).
3. `npm audit` — verify the 5 moderates are cleared (or that
   the residual is strictly smaller and named in the commit).
4. `npm run check:dep-freshness`, `npm run check`,
   `npm run build` — all clean.
5. Land the `testing` capability spec.
6. Archive the change; the spec becomes canonical.

**Rollback:** `git revert` the apply commit; no schema/data work.

## Open Questions

- None blocking. If `ink-testing-library@latest` rejects vitest
  3 outright, fall back to its highest version that accepts
  vitest 3 (decision 4 covers this).
