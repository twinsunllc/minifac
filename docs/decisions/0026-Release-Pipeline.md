---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0026: Release pipeline (GitHub-tagged, OIDC-published, provenance-signed)

## Context

We need a release path that:

1. **Reproduces** — every published tarball traces back to a
   specific commit + workflow run.
2. **Verifies** — downstream consumers can confirm the tarball
   came from us, not a compromised laptop or a tampered mirror.
3. **Doesn't sprout new secrets** — a long-lived `NPM_TOKEN`
   sitting in repo secrets is exactly the kind of credential
   that gets exfiltrated by a malicious dep, a compromised
   action, or a successful supply-chain attack (the
   `tj-actions/changed-files` 2025 incident exfiltrated
   `NPM_TOKEN` from hundreds of repos before being yanked).

The npm registry now supports two technologies that together
let us hit all three goals: **package provenance** (since npm
9.5) and **trusted publishers / OIDC** (GA mid-2024). Both are
free.

## Decision

`.github/workflows/release.yml` is the only path to npm. It:

- Triggers on a pushed `v*.*.*` tag (or manual
  `workflow_dispatch` with a tag input)
- Refuses to publish if the tag and `package.json` version
  disagree
- Runs the same gates as `ci.yml` (dependency freshness,
  install, lint, test, build, audit) — `release.yml` is the
  *only* path that publishes, so any quality bar we want on
  the registry has to be enforced here
- Builds tarball + zip dist archives, attaches them to a
  GitHub Release with notes extracted from `CHANGELOG.md`
- Runs `npm publish --access public --provenance`

### Authentication: OIDC trusted publisher, no `NPM_TOKEN`

The publish step authenticates via GitHub's OIDC token, not a
long-lived secret. Setup is one-time on npmjs.com (per package,
not per repo):

1. After the first publish, navigate to
   `https://www.npmjs.com/package/minifac/access/trusted-publishers`
2. Add a publisher: org=`twinsunllc`, repo=`minifac`, workflow
   filename=`release.yml`, ref pattern=`v*`
3. From then on, the workflow publishes with zero secrets — npm
   verifies the OIDC token against the configured publisher
   binding before accepting the tarball

For the **very first** publish, the package doesn't exist yet
and there's no publisher binding to verify against. Two
options:

- **Bootstrap with a one-shot token**: locally run
  `npm login` → `npm publish --access public` to claim the
  name with the initial version, then configure the trusted
  publisher on npmjs.com and use the workflow for everything
  after. Token can be deleted immediately.
- **Bootstrap with the workflow**: npm supports publishing a
  brand-new package via OIDC if a trusted publisher binding
  exists for the namespace. Slightly more friction; documented
  if we need it.

We use option 1 for the bootstrap and option 2 / the OIDC
flow for everything after.

### Provenance attestation

`--provenance` attaches a SLSA-shaped statement to the published
tarball that names:

- The git repository + commit SHA the tarball was built from
- The workflow file + job that produced it
- The build invocation context

Downstream consumers can verify with `npm install --provenance`
or by inspecting the package on the registry UI. This is the
strongest available signal for "this came from us" and is
meaningfully harder to forge than a static signature.

### Freshness gate during release

`scripts/check-dep-freshness.mjs` runs as the first build step
in `release.yml`, before any `npm ci`. The rationale matches
`ci.yml`: a fresh dep shouldn't execute postinstall during a
release any more than during a regular push.

## Consequences

- We never ship a release that wasn't built in CI from a
  matching tag. Local-laptop publishes are not possible after
  the initial bootstrap.
- Anyone with `contents: write` on the repo can effectively
  ship a release (by pushing a tag), so branch protection on
  `main` + tag protection are downstream prerequisites for
  any sensitive release window. Worth setting up before the
  repo goes public; not in scope for this ADR.
- Releases happen on the cadence of human-pushed tags. No
  auto-tagging from CI — that would let CI ship code that
  hadn't been blessed.
- `--provenance` requires `id-token: write` permission on the
  release job. Scoped to that one job; not granted workflow-wide.

## Alternatives considered

- **`NPM_TOKEN` secret**: simpler, but the secret is the asset
  attackers hunt for. tj-actions/changed-files was exactly this
  failure mode. Rejected.
- **Manual publish from a maintainer laptop**: no audit trail,
  no provenance, drift between local toolchain and published
  artifact. Acceptable only for the bootstrap publish.
- **Sigstore / Cosign signatures separately**: provenance via
  `--provenance` is the npm-native equivalent and is what
  consumers will actually verify. Adding Sigstore on top is
  belt-and-suspenders we don't need yet.
- **Release Please / Changesets / semantic-release for
  auto-versioning**: nice ergonomics but adds tooling. We can
  layer it on later; today the `version-matches-tag` check
  enforces discipline without the dep.

## Bootstrap checklist (first publish)

Before pushing the first `v0.1.0` tag:

- [ ] `npm pack --dry-run` from a clean checkout — confirm the
      tarball contents are what we expect
- [ ] `npm login` from a trusted machine
- [ ] `npm publish --access public` (one-time, manual)
- [ ] Configure trusted publisher on npmjs.com per the
      "Authentication" section above
- [ ] `CHANGELOG.md` has a `## [0.1.0]` section the release
      workflow can extract
- [ ] Verify `package.json` version is `0.1.0`
- [ ] Subsequent releases: bump `package.json`, update
      CHANGELOG, tag, push the tag, watch the workflow

## Related

- [[0024-CI-Security-Policy]] — frames the SHA-pinning + audit
  discipline this workflow inherits
- [[Roadmap]] — open-source-readiness chore tier; install path
- `CHANGELOG.md` — the release notes source the workflow reads
