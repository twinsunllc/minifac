## Why

`npm audit` is failing. A fresh audit of the dependency tree surfaced
five advisories — one critical, three high, one low:

- **critical** — `vitest` < 3.2.6 (UI server arbitrary file
  read/execute, GHSA-5xrq-8626-4rwp)
- **high** — `hono` ≤ 4.12.24 (path traversal in `serve-static`
  plus several adapter advisories, GHSA-wwfh-h76j-fc44 et al.).
  `hono` is a **production** dependency, pulled in through
  `@modelcontextprotocol/sdk` (ADR-0029's MCP outputs transport).
- **high** — `vite` 7.0.0–7.3.3 and `ws` 8.0.0–8.20.1
- **low** — `esbuild` ≤ 0.28.0 (dev-server arbitrary file read on
  Windows), a transitive dev dependency of `vitest`/`vite`

Per [`0024-CI-Security-Policy`](../../../docs/decisions/0024-CI-Security-Policy.md)
rule 6 (audit signal handling), a failing audit gets confirmed,
classed by exposure, and fixed by bumping or pinning — never by a
blind `npm audit fix --force`. This change does that.

Separately, 0024 rules 1 and 2 (pin every `uses:` by SHA; only
verified first-party / verified-publisher actions) are currently
enforced **by review and convention only**. There is no automated
gate that fails a PR which introduces an unpinned or unverified
action. We have a first-party tool for exactly this —
`twinsunllc/github-actions-security-checker` — and a fresh `v1.4.3`
that recognises the `github/*` namespace as a verified first-party
publisher. Wiring it into CI turns rules 1–2 from "we try to
remember" into "the build won't go green otherwise."

## What Changes

- **DEPS** Bump `vitest` `^3.2.4` → `^4.1.8`. Vitest 4 drops the
  vulnerable transitive `esbuild` entirely, clearing both the
  critical (vitest UI) and the low (`esbuild`) advisories. The 964
  tests pass unchanged under v4 (validated in a scratch worktree).
- **DEPS** Add an `overrides` block pinning `hono` to `4.12.25` —
  the first patched release (> 4.12.24). 4.12.25 is also old enough
  to clear the 3-day dependency-freshness gate
  (`scripts/check-dep-freshness.mjs`), whereas the newest `4.12.26`
  that `npm audit fix` selects is too fresh and would fail rule 4.
- **DEPS** Refresh `package-lock.json` so `vite` and `ws` resolve to
  patched releases (`ws` → 8.21.0). Net result: `npm audit` reports
  **0 vulnerabilities** and `npm audit --audit-level=high` exits 0.
- **NEW** `.github/workflows/action-security.yml` — a PR + push gate
  that runs `twinsunllc/github-actions-security-checker`, pinned by
  SHA to `v1.4.3`, over `.github/workflows`. It fails the build on
  any unpinned or unverified-publisher action. v1.4.3 treats
  `github/*` (e.g. `github/codeql-action`) as first-party-verified
  natively, so no allowlist is needed for it. The checker's **own**
  org, `twinsunllc`, is not a Marketplace-verified publisher, so it
  is allowlisted as a hand-vetted first-party exception per 0024
  rule 2 — allowlisting bypasses publisher verification but still
  enforces the SHA pin.
- **NEW** [`0034-Action-Pinning-Enforcement`](../../../docs/decisions/0034-Action-Pinning-Enforcement.md)
  — an ADR extending 0024, recording the move from
  convention-enforced to CI-enforced action pinning, why the checker
  is pinned to a SHA like any other action, and why no allowlist is
  required.
- **DOCS** `CHANGELOG.md` `[Unreleased]` notes the audit remediation
  and the new workflow.

This change **supersedes dependabot PR #4** ("Bump esbuild and
vitest"): #4 makes the same vitest bump but, built on a stale
lockfile, leaves the `hono` and `ws` highs in place and would fail
the `--audit-level=high` gate. #4 auto-closes when this merges.

## Capability-spec impact

None. CI and supply-chain policy in this repo is ADR-homed
(`docs/decisions/0024`, and now `0034`), not expressed as an
`openspec/specs/*` capability. There is no behavioural change to the
minifac runner, CLI, or factory schema — so this change archives
without folding any spec delta. The dependency bumps are maintenance;
the durable, reviewable decision is the new ADR.
