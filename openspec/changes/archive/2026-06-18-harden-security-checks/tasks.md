## 1. Dependency remediation (npm audit → 0)

- [x] 1.1 In `package.json`, bump `devDependencies.vitest` from
      `^3.2.4` to `^4.1.8`.
- [x] 1.2 In `package.json`, add a top-level `overrides` block:
      `{ "hono": "4.12.25" }`.
- [x] 1.3 Regenerate `package-lock.json` (`npm install`), then run
      `npm audit fix` to pull `ws` up to its patched release
      (8.21.0). Confirm no `--force` was needed.
- [x] 1.4 Verify `npm audit` reports 0 vulnerabilities and
      `npm audit --audit-level=high` exits 0.
- [x] 1.5 Verify `npm run check:dep-freshness` passes (all resolved
      deps ≥ 3 days old — in particular `hono@4.12.25`).
- [x] 1.6 Verify `npm test` (964 tests) and `npm run check` pass
      under vitest 4.

## 2. Action-pinning CI gate

- [x] 2.1 Add `.github/workflows/action-security.yml` triggered on
      `push` to main and `pull_request` to main, with top-level
      `permissions: { contents: read }`.
- [x] 2.2 The job checks out (pinned `actions/checkout`) and runs
      `twinsunllc/github-actions-security-checker`, pinned by SHA to
      `v1.4.3` (`0ad4f2eca85a1c0a633674e88a1c30e574c22927`), with
      `github_token: ${{ secrets.GITHUB_TOKEN }}` and
      `allowlist: twinsunllc` (the checker's own org — a hand-vetted
      first-party exception per 0024 rule 2; SHA pin still enforced).
- [x] 2.3 Confirm the checker passes locally against
      `.github/workflows` (13/13 verified + pinned, exit 0) — the
      new workflow file included.

## 3. Decision record + changelog

- [x] 3.1 Write `docs/decisions/0034-Action-Pinning-Enforcement.md`
      extending 0024: convention → CI enforcement, checker SHA-pinned
      as a hand-vetted first-party exception, no allowlist rationale,
      and the audit remediation under 0024 rule 6.
- [x] 3.2 Add the "Related" backlink from 0034 and note the audit
      remediation. Update `CHANGELOG.md` `[Unreleased]` with the
      audit fix and the new workflow.

## 4. Verify + archive

- [x] 4.1 Re-run the full gate set: `npm run check`, `npm test`,
      `npm audit --audit-level=high`, `npm run check:dep-freshness`,
      and the checker against `.github/workflows`.
- [x] 4.2 Archive this change to
      `openspec/changes/archive/2026-06-18-harden-security-checks/`.
      No `openspec/specs/*` delta to fold (policy is ADR-homed).
