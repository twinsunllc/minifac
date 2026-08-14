---
status: accepted
date: 2026-08-14
supersedes: []
superseded-by: null
tags: [decision]
---

# 0038: Remove transitive `overrides`; exact pins block Dependabot

## Context

[`0034-Action-Pinning-Enforcement`](0034-Action-Pinning-Enforcement.md)
recorded two `overrides` entries (`hono`, `nanoid`) added as part of a
0024 rule 6 remediation, and stated the exit condition in its
Consequences:

> They are floors, not long-term pins: each can be removed once its
> upstream ships a patched-and-aged version within the consuming
> package's own range.

That condition is now met for every entry. This note records the
removal, so 0034's Consequences bullet is read as discharged rather
than current.

The removal is not merely housekeeping. Between 0034 and now the block
grew to five entries and produced a failure that was invisible from
inside the policy:

**Dependabot's npm updater does not edit `overrides`.** For a
transitive dependency it remediates an advisory by rewriting the
lockfile entry — but an exact override forces resolution, so any
lockfile change it proposed would be reverted on the next install. It
has nothing it can write, so it opens nothing. It does not warn, and it
does not fail. The alert simply stays open with no PR attached.

Six alerts (`hono` ×4, `fast-uri`, `postcss`) sat open this way while
the nightly `security` workflow failed on
`npm audit --audit-level=high`. The correlation was exact: every
package in the block was stuck, and every alert Dependabot *did* fix
(`ip-address`, `@hono/node-server`, `body-parser`) was a package not in
it.

The pins accumulated from a real bind, twice. `npm audit` demands the
*newest* patched version; the rule 4 freshness gate
([`0024-CI-Security-Policy`](0024-CI-Security-Policy.md)) forbids
anything published in the last 3 days. An advisory fix is usually hours
old, so `npm audit fix` reliably produces exactly what the freshness
gate rejects. With a red nightly build, both 0034 and the later
`fix-audit-highs` change escaped by hand-picking an older patched
version and pinning it exactly.

Each pin was correct the day it was written. The defect is asymmetry:
**an exact pin is permanent, but the reason for it — that the fix was
too fresh — expires in 3 days.** Nothing unwinds it, and Dependabot,
the thing that would have, is the thing the pin disables. The ratchet
was already visible in the `fix-audit-highs` change, which noted the
0034 `hono` pin "was holding the tree on a version covered by three
newer moderate advisories" and hand-bumped it — treating the symptom as
a one-off rather than as the mechanism. By 2026-08-14 two pins had
drifted *below* what their own parents declare: `postcss` held at
8.5.22 against vite's `^8.5.25`, `nanoid` at 3.3.12 against postcss's
`^3.3.16`.

## Decision

**Delete the `overrides` block entirely rather than refresh it.** Every
parent range now resolves to a patched version unaided:

| package | pinned | resolves to | via parent range |
| --- | --- | --- | --- |
| `fast-uri` | 3.1.4 | 3.1.5 | `ajv ^3.0.1` |
| `hono` | 4.12.31 | 4.13.1 | `@hono/node-server ^4`, `@modelcontextprotocol/sdk ^4.11.4` |
| `nanoid` | 3.3.12 | 3.3.18 | `postcss ^3.3.16` |
| `postcss` | 8.5.22 | 8.5.26 | `vite ^8.5.25` |
| `body-parser` | 2.3.0 | 2.3.0 | `express ^2.2.1` (pin was already inert) |

`npm audit` reports 0 vulnerabilities at both `high` and the full
report; the freshness gate is green across all 215 resolved deps.

**Where a fix is too fresh, wait rather than pin.** This case
reproduced mid-removal: max-satisfying resolution pulls `hono` 4.13.2,
1.1 days old, which fails rule 4. Rather than add a sixth pin, the
lockfile was round-tripped through a *temporary* override which was
then removed — `npm install` will not bump an in-range lockfile entry,
so the patched-and-aged 4.13.1 holds with no override left behind.
4.13.2 is picked up normally once it ages past the gate.

That technique is the general remedy: it reaches a patched, aged
version without creating anything Dependabot must later fight.

## Consequences

- Dependabot can remediate these packages again. The six open alerts
  close on the next scan.
- 0034's "two `overrides` entries are now carried" Consequence is
  discharged. 0034 is otherwise untouched and remains binding — its
  action-pinning gate is unaffected by this note, and 0034 is *not*
  superseded.
- `package.json` carries no `overrides` block at all, so the failure
  mode cannot recur silently. Reintroducing one is now a visible act
  with this note to argue against it.
- Transitive versions are no longer hand-held. Resolution follows
  parent ranges, which is what the freshness gate and `npm audit`
  already assume.
- The underlying tension between rule 4 (freshness) and `npm audit`
  (newest) is **not** resolved here. It recurs at the next advisory.
  Documenting the standing rule — that exact pins block security
  updates, and the remedy is to wait out the 3 days — in
  `.github/dependabot.yml` and as a 0024 rule 6 amendment is deferred
  to its own change via `/opsx:propose`.

## Alternatives considered

- **Refresh the pins to current patched versions.** Rejected: it
  restores the exact state that disabled Dependabot, and guarantees a
  third round of the same manual bump. The pins were never the fix;
  they were the reason the fix stopped arriving.
- **Convert the exact pins to ranges (`"hono": "^4.13.1"`).** Rejected:
  a range override stops the *downgrade* problem but not the Dependabot
  one — the updater still won't edit `overrides`, so security PRs stay
  suppressed. Weaker on the only axis that mattered.
- **Pin `hono` to 4.13.1 to dodge the freshness gate.** Rejected: it is
  the precise mistake this note exists to record, and it would have
  been the sixth instance. The lockfile round-trip reaches the same
  version with nothing left behind.
- **Set `MIN_DEP_AGE_DAYS=0` and take `hono` 4.13.2.** Rejected: 0024
  reserves that override for a same-day CVE with rationale in the PR.
  A routine bump does not qualify, and 4.13.1 is already patched.
- **Promote `hono` to a direct dependency** so Dependabot manages it
  normally. Rejected: nothing under `src/` imports `hono` — it arrives
  only via `@hono/node-server` and `@modelcontextprotocol/sdk`.
  Declaring it would be a false statement about the code to work around
  a tooling limitation.

## Related

- [`0024-CI-Security-Policy`](0024-CI-Security-Policy.md) — rule 4
  (dep freshness) and rule 6 (audit signal handling); the two rules
  whose tension produced the pins
- [`0034-Action-Pinning-Enforcement`](0034-Action-Pinning-Enforcement.md)
  — added the original `hono` / `nanoid` overrides and named the exit
  condition this note satisfies
- [`0036-Dependabot-Auto-Merge`](0036-Dependabot-Auto-Merge.md) — the
  auto-merge flow that these alerts never reached
- `.github/dependabot.yml` — ecosystem config; the standing-rule note
  is deferred there
