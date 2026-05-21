---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0024: CI + supply-chain security policy

## Context

We're standing up `.github/workflows/` ahead of the first public
release. GitHub Actions has an established attack surface: malicious
actions can exfiltrate secrets, tamper with build artifacts, or
inject backdoors into release tarballs. The well-known compromises
(`tj-actions/changed-files` in 2025, `reviewdog/action-setup` in
the same window, the `nx` postinstall worm in 2024) all relied on
two recurring weaknesses:

1. **Mutable references.** Workflows pinned actions by tag (`@v4`)
   or branch (`@main`), so a forced tag move or a compromised
   maintainer account silently changed the code being executed.
2. **Excessive default permissions.** Actions inherited write
   access to repo contents, releases, packages, and tokens they
   never needed.

We get one chance to set this discipline before there's a contributor
base. Setting it now costs nothing; retrofitting it later costs
contributor goodwill and audit time.

## Decision

The minifac project adopts these rules for every workflow:

### 1. Pin every `uses:` by full commit SHA

```yaml
uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
```

The trailing comment names the human-readable version. The SHA is
the authoritative reference. Tags and branches are never used at
the `uses:` site.

Updates flow through
[`pinact`](https://github.com/suzuki-shunsuke/pinact). Running
`pinact run` rewrites the file in place; `pinact update` refreshes
all SHAs against current tag heads. Contributors are expected to
run one of those commands when touching a workflow.

### 2. Verified publisher allowlist

The only `uses:` sources we accept:

- First-party GitHub orgs: `actions/*`, `github/*`
- The publisher's verified badge on GitHub Marketplace
- Hand-vetted exceptions, with a short note in the workflow file
  explaining why

This eliminates the typosquat / brand-similar attack vector. No
random community actions, however popular, without a deliberate
discussion captured in a follow-on ADR.

### 3. Minimum permissions, declared explicitly

Every workflow declares a top-level `permissions:` block with
`contents: read` as the floor. Jobs that need more (e.g.,
`security-events: write` for CodeQL, `pull-requests: write` for
dependency-review comments) declare it at the job level, not the
workflow level. Default token scope is therefore the minimum
viable.

### 4. Dependency-age cooldown (publish-then-yank defense)

A newly-published npm package gets ~3 days before we'll install
it. The check lives in `scripts/check-dep-freshness.mjs`, runs as
the first build step in `ci.yml` (before `npm ci`), and fails if
any package in `package-lock.json` was published less than
`MIN_DEP_AGE_DAYS` ago (default 3).

The rationale: most recent supply-chain attacks via npm (the nx
postinstall worm, several typosquats, the `event-stream`
incident) were caught and yanked within 24–72 hours of publish.
A cooldown window forces the malicious version through that
detection-and-yank window before our CI will ever execute its
postinstall hook.

Cost: dep upgrades from a freshly-released upstream sit red for
up to 3 days. That's almost always fine — emergencies (a real
CVE that needs a same-day patch) can override by setting
`MIN_DEP_AGE_DAYS=0` in the workflow with the rationale in the
PR description.

Why a custom script instead of Renovate's `minimumReleaseAge`:
Renovate prevents *automated* PR creation against fresh deps,
but doesn't gate *manual* PRs. The CI script gates everything
that hits the build, regardless of how the lockfile change
arrived. Both layered (eventual Renovate setup) is better than
either alone, but the CI script is the floor.

### 5. Coverage

The initial workflow set:

- **`ci.yml`** — build + test + lint on every push to main and
  every PR. Concurrency-cancels superseded runs.
- **`dependency-review.yml`** — PR gate. Fails on `high` severity
  introduced by a PR. Posts a comment summary on failure.
- **`security.yml`** — nightly `npm audit --audit-level=high`
  against the **full** dep tree (production + dev). A separate
  informational step runs the same audit at `moderate` and
  never fails the job, for visibility without noise. We do
  *not* set `--omit=dev` — dev deps execute on CI via
  postinstall hooks and have been the entry vector for several
  recent supply-chain attacks (nx postinstall worm,
  `tj-actions/changed-files`, `reviewdog/action-setup`).
  Treating them as out-of-scope would be a false economy.
- **`codeql.yml`** — JS/TS static analysis on push, PR, and a
  weekly schedule. Build-mode `none` (TS is interpreted; CodeQL
  doesn't need to build).

We avoid running anything on `pull_request_target` until there's a
concrete reason to. That trigger has untrusted-input semantics
that have produced most public Action-related CVEs.

### 6. Audit signal handling

When the nightly `security.yml` fails, the on-call response is:

1. Confirm the vuln exists (the audit isn't a false positive)
2. Determine production vs. dev exposure
3. Bump the offending dep (preferred) or pin around it
4. If no patch exists: open a tracking issue and document the
   exposure in `docs/decisions/`

We do *not* run `npm audit fix --force` blindly — that has shipped
broken upgrades into trees more than once.

## Consequences

- New contributors need to know about `pinact` (documented in
  `CONTRIBUTING.md`). Slightly higher friction; meaningfully lower
  supply-chain risk.
- Workflow updates need a SHA refresh step every few months as
  actions release new versions. Cheap; one command.
- We can't grab "look how cool this random action is" snippets from
  blog posts without verifying the publisher first. Trade-off
  accepted.
- The dependency-review action posts comments to PRs, which
  requires the elevated `pull-requests: write` permission scoped to
  that one job. The blast radius if compromised: comment spam, not
  code execution.

## Alternatives considered

- **Trust verified actions by tag (no SHA pin).** Simpler but
  defeated by the 2025 tag-move attacks. Rejected.
- **`Dependabot` for actions instead of `pinact`.** Compatible —
  Dependabot can be configured to write SHA pins (`actions:
  pin-by-sha`). Worth adding once we open the repo; the manual
  `pinact` floor remains.
- **Ban CodeQL because it's "GitHub-flavored."** It's first-party,
  free, and catches a non-empty set of real bugs. Keeping it.
- **Skip nightly audits; rely on Dependabot alerts.** Dependabot
  alerts are reactive; nightly audits are scheduled and visible to
  the team without anyone watching Security tab notifications.
  Both is better than either alone.

## Open questions

- Whether to add OpenSSF Scorecard once the repo is public — yes
  probably, file as a follow-up brief.
- Whether to enable Dependabot version updates (PRs) in addition to
  security updates — leaning yes once we have CI signal we trust.
- Whether to add `actionlint` as a pre-commit hook to catch
  workflow syntax errors locally — small win, easy add later.

## Related

- [[Roadmap]] — open-source-readiness chore tier
- `CONTRIBUTING.md` — points contributors at `pinact`
