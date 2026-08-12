---
status: accepted
date: 2026-08-12
supersedes: []
superseded-by: null
tags: [decision]
---

# 0036: Dependabot with auto-merged patch/minor, human-only majors

## Context

Dependency updates on this repo have been entirely manual. The
supply-chain posture from
[`0024-CI-Security-Policy`](0024-CI-Security-Policy.md) is strong on
*what may enter the tree* (SHA-pinned actions, `min-release-age=3`,
the lockfile freshness gate, `npm audit` at high) but says nothing
about *keeping the tree current*, and stale dependencies are their own
advisory exposure.

`twinsunllc/scarif-web` has run a Dependabot flow since 2026-06 and has
already paid the tuition on three failure modes (SCARIFW-1178, -1201,
-1203, -1213). This decision ports that flow rather than reinventing
it, with two changes for this repo's stricter dependency policy and one
correction to a gap scarif-web still has.

## Decision

### Routine updates: weekly, grouped, npm majors suppressed

`.github/dependabot.yml` covers `npm` and `github-actions` — the only
two ecosystems here — weekly on Monday 09:00 America/Chicago, grouped
into a `-patch` and a `-minor` group per ecosystem.

Routine `version-update:semver-major` bumps are ignored **for npm
only**. A major is never auto-merged, so a routine major PR is pure
queue; scarif-web accumulated 27 untriaged ones across three repos
before suppressing them. `github-actions` majors are deliberately still
opened: action majors are largely how we stay on supported runner
runtimes, they rarely arrive via advisories, and they are the cheapest
majors to review.

**Security updates are never suppressed.** The `ignore` is expressed as
`dependency-name: "*"` **scoped by `update-types` on the same sequence
item**, because per GitHub's options reference `update-types` affects
version updates only. The `dependency-name`-alone and `versions` ignore
parameters *do* apply to security updates; either would silently
suppress advisory fixes, invisibly, until an advisory went unpatched.
`open-pull-requests-limit: 0` is likewise not an alternative — it
exempts security updates but suppresses the patch/minor churn this flow
exists to clear.

### Cooldown matches the freshness gate

The npm ecosystem sets `cooldown: default-days: 3`, mirroring
`min-release-age=3` in `.npmrc` and `scripts/check-dep-freshness.mjs`
(0024 rule 4). Without it, a Monday PR carrying a package published
over the weekend opens red on the freshness check and sits there until
someone re-runs CI three days later. `cooldown` is version-updates-only
and so cannot delay a security update.

### Auto-merge: patch always, minor only above 1.0.0, never major

`.github/workflows/dependabot-automerge.yml` calls
`gh pr merge --auto --squash` on Dependabot's PRs when the update type
is `semver-patch`, or `semver-minor` **and every dependency the PR
touches was already at 1.0.0 or above**. Majors — routine or
security-driven — are always left for a human.

The 0.x carve-out is the SCARIFW-1213 lesson: under semver a 0.x minor
is exactly where breaking changes are permitted to live, and by
convention that is what they are. scarif-worker#326 (web-tree-sitter
0.21.0 → 0.26.11, reported as a minor inside an `npm-minor` group) was
auto-merged and broke `main`'s TypeScript build a day after a human had
judged that same bump breaking and deferred it. Patch stays
unconditional at any version, 0.x included — a 0.x patch is
conventionally safe and is not where the risk lives.

The gate reads **the PR body**, not `fetch-metadata`'s
`previous-version`. On a grouped PR — which is how both ecosystems are
configured — that output characterises one arbitrary member and says
nothing about the rest. The body carries a version line per member and
the `dependency-names` trailer carries authoritative membership; the
gate cross-checks the two and fails closed (`all-stable=false`) if a
version is unreadable or a named member has no line.

Minor is included at all because `fetch-metadata` reports a grouped
PR's update type as the **highest** bump across members, so patch-only
auto-merge disqualifies a whole group over one minor member. Patch-only
and grouped updates do not compose.

### Required status checks are a precondition, not an implication

`gh pr merge --auto` does not bypass branch protection — but it also
does not supply it. With no required checks on `main`, a Dependabot PR
is mergeable the instant it opens and `gh` merges it **immediately**
rather than enabling auto-merge. This is not hypothetical: scarif-web
has no protection on `main`, and PR #1064 merged 5 seconds after the
workflow started, long before CI could have finished. "Auto-merge green
builds" is false there.

So this decision includes the repo configuration, without which the
workflow is a merge-on-open bot:

- `allow_auto_merge` enabled on the repository.
- A branch ruleset on `main` requiring these checks to pass:
  `build + test + lint (node 22)`, `build + test + lint (node 24)`,
  `analyze (javascript-typescript)`,
  `audit workflow actions (pinning + verified publishers)`, and
  `review changed dependencies`.

## Consequences

- Weekly patch and stable-minor churn clears itself on green CI, and
  the four PR gates (`ci`, `codeql`, `action-security`,
  `dependency-review`) become the review.
- Every major reaches a human, and only reaches one when it resolves an
  advisory (npm) or moves an action (github-actions).
- Pre-1.0 dependencies — of which this tree has several — get patch
  bumps automatically and minor bumps by hand. That is more manual work
  than scarif-web's original config and is the point.
- `main` gains required status checks, which also apply to direct
  pushes. Release commits (`chore: release 0.1.2`) currently land that
  way and will need either a PR or an explicit ruleset bypass for the
  repo admin.
- The flow depends on Dependabot's PR body format. The gate fails
  closed if that format changes, so the failure mode is unmerged PRs,
  not bad merges.

## Alternatives considered

- **Patch-only auto-merge.** Rejected: with grouped PRs, one minor
  member disqualifies the batch. scarif-web#1008 left nine green patch
  bumps unmerged for six days for exactly this reason.
- **Ungrouped updates + patch-only.** Rejected: trades one weekly
  review for a dozen PRs a week, and loses the ability to review or
  revert a patch batch as a unit.
- **Suppress majors with `open-pull-requests-limit: 0` or a bare
  `dependency-name` ignore.** Rejected: both reach security updates.
  This is the single most dangerous way to get this config wrong,
  because nothing surfaces the suppression.
- **Suppress github-actions majors too.** Rejected: action majors are
  the mechanism for runner-runtime deprecations and rarely arrive as
  advisories. Suppressing them means rotting toward a hard break with
  no signal.
- **Trust `fetch-metadata`'s `previous-version` for the 0.x gate.**
  Rejected: it describes one member of a grouped PR. This is the bug
  that shipped web-tree-sitter.
- **Auto-merge majors when CI is green.** Rejected: a green build is
  not evidence a breaking change is safe, and 0024's posture is that
  supply-chain risk is reviewed, not inferred.
- **No branch protection (scarif-web's current state).** Rejected: it
  makes the auto-merge workflow a merge-on-open bot, which is strictly
  worse than no automation.

## Related

- [`0024-CI-Security-Policy`](0024-CI-Security-Policy.md) — rules 1, 2
  and 4 that this flow must not undermine
- [`0034-Action-Pinning-Enforcement`](0034-Action-Pinning-Enforcement.md)
  — the `action-security` gate that github-actions bumps must clear
- `.github/dependabot.yml`, `.github/workflows/dependabot-automerge.yml`
- `twinsunllc/scarif-web` — the origin of this flow (SCARIFW-1178,
  -1201, -1203, -1213)
