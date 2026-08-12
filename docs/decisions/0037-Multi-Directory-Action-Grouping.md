---
status: accepted
date: 2026-08-12
supersedes: []
superseded-by: null
tags: [decision]
---

# 0037: Group multi-directory actions so Dependabot can't split them

## Context

[`0036-Dependabot-Auto-Merge`](0036-Dependabot-Auto-Merge.md) landed the
Dependabot flow. Its first run opened four `github-actions` major PRs,
and two of them could never pass:

```
##[error]Loaded a configuration file for version '4.37.6',
         but running version '3.35.5'
```

`github/codeql-action/init` and `github/codeql-action/analyze` are two
directories of a **single** action, pinned to the same commit. Dependabot
resolves each directory as its own dependency, so it opened #14 (init →
v4.37.6) and #17 (analyze → v4.37.6) separately. Each PR moves half the
pair, and the halves refuse to run together — so both were red, and
neither could be made green on its own. Merging both would fix it, but
0036 requires green checks to merge, so the pair deadlocks.

0036's groups only list `patch` and `minor`, which is why these arrived
ungrouped: `github-actions` majors are deliberately still opened (they
are how we learn about runner-runtime deprecations) and majors match no
group.

## Decision

Add a `codeql-action` group to the `github-actions` ecosystem matching
`github/codeql-action*`, and add `exclude-patterns` for the same glob to
the two wildcard groups so a patch or minor cannot match both and split
again.

This group is **the only one that lists `major`**. That is what makes the
pair travel in one PR, since the failure mode is a major.

Grouping does not make it auto-merge. A grouped PR reports the highest
semver change across its members, so a codeql-action major reports
`semver-major` and `dependabot-automerge.yml` leaves it for a human —
unchanged from 0036.

`.github/workflows/codeql.yml` also carries an inline note that the two
`uses:` lines move together, so the constraint is visible at the point of
edit and not only in the Dependabot config.

## Consequences

- codeql-action bumps arrive as one reviewable PR that can actually go
  green.
- Any future multi-directory action needs the same treatment. The
  symptom is recognisable: two Dependabot PRs, same action, same target
  version, both red.
- The `major` entry in this one group is a deliberate exception to
  0036's "no group lists major" rule. It is safe only because grouping
  changes *how many PRs* open, not *what auto-merges*.
- Dependabot's stale `# v3` pin comment (it rewrote the SHA but left the
  comment) is corrected to `# v4.37.6` by hand. Worth spot-checking on
  future action bumps.

## Alternatives considered

- **Merge #14 and #17 together as-is.** Rejected: neither can go green
  alone, so landing them means bypassing the required checks 0036 just
  established. It would also leave the splitting behaviour in place to
  recur at v5.
- **Pin codeql-action by tag (`@v4`) instead of SHA.** Would dodge the
  split entirely, but breaks 0024 rule 1 (SHA-pin every `uses:`) and the
  `action-security` gate from 0034 would fail it.
- **Drop CodeQL from the repo.** Considered and rejected on 2026-08-12:
  it is free on public repositories (minifac appears in the org's
  Code Security billing report with `total_advanced_security_committers:
  0`), standard-runner Actions minutes are free on public repos, and it
  was already passing. Cost was ~1 minute per PR.
- **Group ALL github-actions majors together.** Rejected: a single
  grouped major PR mixing unrelated actions is harder to review and to
  revert than one PR per action. Only the actions that *must* move
  together are grouped.

## Related

- [`0036-Dependabot-Auto-Merge`](0036-Dependabot-Auto-Merge.md) — the flow
  this refines
- [`0024-CI-Security-Policy`](0024-CI-Security-Policy.md) — rule 1, why
  tag pinning is not an option
- `.github/dependabot.yml`, `.github/workflows/codeql.yml`
