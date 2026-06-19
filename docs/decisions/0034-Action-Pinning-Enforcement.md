---
status: accepted
date: 2026-06-18
supersedes: []
superseded-by: null
tags: [decision]
---

# 0034: Enforce action pinning + verified publishers in CI

## Context

[`0024-CI-Security-Policy`](0024-CI-Security-Policy.md) set two rules
about GitHub Actions:

1. **Rule 1** — pin every `uses:` by full commit SHA.
2. **Rule 2** — only first-party (`actions/*`, `github/*`) or
   Marketplace-verified-publisher actions, plus hand-vetted
   exceptions with a note.

Until now both were enforced by **review and convention** —
`pinact` is documented in `CONTRIBUTING.md`, but nothing fails a PR
that introduces `uses: some/action@main` or an unverified
third-party action. The 2025 `tj-actions/changed-files` and
`reviewdog/action-setup` compromises are precisely what these rules
defend against, and a convention that depends on a reviewer noticing
a 40-character SHA is missing is a weak control.

We now have a first-party tool for this audit —
`twinsunllc/github-actions-security-checker` — and a release
(`v1.4.3`) that correctly treats the `github/*` namespace as a
verified first-party publisher (that fix shipped upstream as part of
this same body of work). The cost of turning rules 1–2 into a hard
gate is one small workflow file.

This decision also records the dependency remediation done alongside
it, under 0024 rule 6 (audit signal handling).

## Decision

### Add an `action-security` CI gate

`.github/workflows/action-security.yml` runs the checker on every
push to `main` and every PR, over `.github/workflows`. The build
fails if any `uses:` is unpinned or resolves to a non-verified,
non-allowlisted publisher. This makes 0024 rules 1–2 self-enforcing
rather than reviewer-dependent.

The checker obeys the rule it enforces: it is itself pinned by SHA
(`0ad4f2eca85a1c0a633674e88a1c30e574c22927  # v1.4.3`).

### Allowlist `twinsunllc`, not `github`

- `github/*` (e.g. `github/codeql-action`) is verified natively by
  v1.4.3, so it needs no allowlist entry.
- `twinsunllc` is first-party to *this* project but is **not** a
  Marketplace-verified publisher, so the checker's scrape-based
  verification cannot confirm it. Rather than weaken the check, we
  treat it as the 0024 rule 2 "hand-vetted exception": the workflow
  passes `allowlist: twinsunllc`, which bypasses publisher
  verification for that namespace **while still enforcing the SHA
  pin**. The exception therefore cannot also introduce an unpinned
  action. The workflow file carries an inline note explaining why.

We deliberately do **not** allowlist `github` — allowlisting trusts a
namespace by bypassing verification; first-party recognition (what
v1.4.3 does for `github/*`) is the stronger posture and keeps the
allowlist to genuine exceptions only.

### Dependency remediation (0024 rule 6)

A failing `npm audit` (1 critical, 3 high, 1 low) was resolved by
bumping, not `--force`:

- `vitest` `^3.2.4` → `^4.1.8` — vitest 4 drops the vulnerable
  transitive `esbuild`, clearing the vitest-UI critical and the
  `esbuild` low at once. The 964-test suite passes unchanged.
- `overrides.hono = 4.12.25` — `hono` is a production dependency
  (via `@modelcontextprotocol/sdk`); 4.12.25 is the first patched
  release that is also old enough to clear the rule 4 freshness gate
  (the newer 4.12.26 is < 1 day old).
- `overrides.nanoid = 3.3.12` — a refreshed lockfile pulled
  `nanoid@3.3.13` (< 1 day old, no advisory) which tripped the
  freshness gate; pinned to the aged 3.3.12. `ws` resolves to the
  patched 8.21.0.

Result: `npm audit` reports 0 vulnerabilities and
`npm audit --audit-level=high` exits 0, with the freshness gate
green.

## Consequences

- A PR that adds an unpinned or unverified action now fails CI with a
  named report, instead of relying on a reviewer.
- New genuine first-party-but-unverified publishers (like
  `twinsunllc`) are added to the workflow's `allowlist` with a note —
  a deliberate, visible action, not a silent bypass.
- The checker is another third-party-authored (first-party-to-us)
  step running in CI. Its blast radius is a read-only audit of
  workflow files with `contents: read` only, and it is SHA-pinned, so
  a future compromised tag cannot silently change what runs.
- Two `overrides` entries (`hono`, `nanoid`) are now carried in
  `package.json`. They are floors, not long-term pins: each can be
  removed once its upstream ships a patched-and-aged version within
  the consuming package's own range.

## Alternatives considered

- **Keep enforcement by convention + `pinact`.** Rejected: a control
  that depends on a human noticing a missing SHA is the exact failure
  mode 0024 was written to avoid.
- **Allowlist `github` instead of relying on native recognition.**
  Rejected: allowlisting bypasses verification for a whole namespace;
  first-party recognition is strictly stronger and keeps the
  allowlist to true exceptions.
- **Pin `esbuild` and stay on vitest 3.** Rejected: vitest 4 removes
  `esbuild` entirely, so the override would pin a dependency that is
  no longer shipped — dead weight for no gain.
- **`npm audit fix --force`.** Rejected per 0024 rule 6 — it has
  shipped breaking upgrades into trees before.

## Related

- [`0024-CI-Security-Policy`](0024-CI-Security-Policy.md) — the policy
  this enforces (rules 1, 2, 4, 6)
- `.github/workflows/action-security.yml` — the gate
- `twinsunllc/github-actions-security-checker` — the checker (v1.4.3)
