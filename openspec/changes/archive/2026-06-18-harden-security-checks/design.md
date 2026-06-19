## Context

Two loosely-coupled security improvements ship together because they
share a motivation (close the gap between 0024's stated policy and
what CI actually enforces) and a review surface (`.github/workflows`
plus the dependency manifest).

Constraints from `CLAUDE.md` and 0024:

- No new runtime dependencies. The `hono` override does not add a
  dependency; it pins an existing transitive one.
- Pin every `uses:` by full commit SHA with a trailing version
  comment (0024 rule 1). The new workflow obeys the rule it enforces.
- Only first-party / verified-publisher actions (0024 rule 2). The
  checker itself is `twinsunllc/*` — a first-party org for this repo —
  and is hand-vetted here with a note, consistent with 0024's
  "hand-vetted exceptions" clause.
- The dependency-freshness gate (0024 rule 4) is the binding
  constraint on which patched versions we may select today.

## Decisions

### Why `hono` via `overrides`, pinned to 4.12.25

`hono` is transitive (`@modelcontextprotocol/sdk` →
`@hono/node-server` → `hono`), so it cannot be bumped from
`dependencies` directly. An npm `overrides` entry forces every path
in the tree to the chosen version. The advisory is fixed in > 4.12.24;
the candidates are 4.12.25 (published 2026-06-09) and 4.12.26
(published 2026-06-18). `npm audit fix` selects 4.12.26, but at
< 1 day old it trips the 3-day freshness gate. 4.12.25 is patched and
9 days old, satisfying both the advisory and rule 4. We pin to an
exact version (not a range) so the lockfile is deterministic and the
freshness gate evaluates a single known-aged release.

When `@modelcontextprotocol/sdk` later ships a release whose own
range floats past 4.12.25, the override remains a safe floor; it can
be removed in a follow-up once the SDK's transitive `hono` is itself
patched-and-aged.

### Why bump vitest to 4 rather than pin esbuild

The `esbuild` low and the `vitest` critical both originate in the
vitest 3 tree. Vitest 4 removes the `esbuild` dependency outright, so
a single major bump clears two advisories with no override surface to
maintain. The alternative — staying on vitest 3 and adding an
`esbuild` override — would pin a dependency vitest 4 no longer ships,
i.e. carry dead weight. The 964-test suite passes unchanged under
vitest 4 (no config or API migration needed for our usage), so the
major bump is low-risk here.

### Why a dedicated workflow file, not a step in `security.yml`

0024 rule 5 established one workflow file per concern (`ci`,
`codeql`, `dependency-review`, `security`). `security.yml` is
specifically the **nightly `npm audit`** job (schedule + manual). The
action-pinning check is a **per-PR gate** with different triggers
(`push`/`pull_request`) and a different failure meaning (a workflow
edit introduced a bad `uses:`, not a dependency CVE). Folding it into
`security.yml` would conflate two triggers and two on-call responses.
A separate `action-security.yml` keeps each file single-purpose and
its failures self-explaining.

### Why pin the checker by SHA, and which allowlist entry is right

The checker is an action like any other, so 0024 rule 1 applies to it
too: it is pinned to the `v1.4.3` commit SHA with a `# v1.4.3`
comment. v1.4.3 is the release that added `github/*` to the
always-verified first-party set, so our existing
`github/codeql-action` usages pass the checker natively — we do **not**
add `allowlist: github`, which would otherwise bypass publisher
verification for the whole `github` namespace rather than trusting it
as first-party-verified.

The one entry we do allowlist is `twinsunllc` — the checker's own
org. `twinsunllc` is first-party to *this* project but is not a
GitHub Marketplace verified publisher, so the checker's scrape-based
verification (correctly) cannot confirm it and flags it. 0024 rule 2
already provides for exactly this: "hand-vetted exceptions, with a
short note in the workflow file explaining why." The checker's
`allowlist` input is the mechanism — it bypasses publisher
verification for the named namespace while still enforcing the SHA
pin (rule 1), so the exception cannot also smuggle in an unpinned
action. The workflow file carries the explaining note inline.

## Risks / Trade-offs

- **vitest 4 major bump.** Mitigated: full suite passes under v4;
  vitest is a dev-only dependency, so any residual surprise is
  contained to local/CI test runs, never the published artifact.
- **`hono` override drift.** If the MCP SDK later pins `hono` below
  4.12.25, the override would force an upgrade the SDK didn't request.
  Low risk for a patch-level bump within the same minor; flagged for
  removal once the SDK's own transitive is patched-and-aged.
- **Checker as a new CI dependency.** It runs third-party-authored
  (first-party-to-us) Python in CI. Blast radius is read-only audit
  of workflow files; it holds no write permissions and is itself
  SHA-pinned, so a compromised future tag cannot silently change what
  runs.

## Migration / Rollout

No migration. On merge: the lockfile changes take effect on the next
`npm ci`; the new workflow runs on the merge commit and every
subsequent PR. dependabot PR #4 auto-closes. No consumer-facing
surface changes.
