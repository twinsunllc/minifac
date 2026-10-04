---
status: accepted
date: 2026-10-04
supersedes: []
superseded-by: null
tags: [decision]
---

# 0047: Bearer SAST + secrets scan gates every PR

## Context

SCARIFW-1550. `bearer scan .` on minifac main (72a5e24) reported one
CRITICAL and three HIGH findings. minifac's CI did not run Bearer at all
(`security.yml` runs `npm audit` nightly), so only scarif-factory's
checks gate saw them, and it records pre-existing findings as advisories
without failing a PR. Nothing in minifac's own pipeline would stop a new
one.

The four findings, triaged against the source:

| Finding | Location | Verdict |
|---|---|---|
| CWE-319 cleartext transmission (critical) | `src/runner/mcp-server.ts` `net.createServer` | False positive: the server listens on a Unix domain socket in a `mkdtemp` (0700) directory, never a TCP port. Pinned by a test in `mcp-server.test.ts`. |
| CWE-22 path traversal (high) | `src/runner/run.ts` `resolveCwd` | Accepted by design: the factory-schema spec accepts any node `cwd`, absolute included; every input is the operator's own. |
| CWE-22 path traversal (high) | `src/runner/run.ts` `buildMissingList` | False positive: builds a diagnostic string only; no filesystem access. `filename` cannot contain a separator (`OutputFileSchema`). |
| CWE-22 path traversal (high) | `src/serve/factories.ts` `FactoryWatcher.rescan` | False positive: `name` is a `readdir` entry filtered by `YAML_RE`. |

The full justification for each is the `comment` of its entry in
`bearer.ignore`.

## Decision

- `.github/workflows/bearer.yml` runs `bearer/bearer-action` with
  `scanner: sast,secrets` and `severity: critical,high` on every pull
  request to `main` and every push to `main`, with
  `permissions: contents: read`. A finding at those severities that
  `bearer.ignore` does not waive fails the job.
- `bearer/bearer-action` is a hand-vetted exception under
  [[0024-CI-Security-Policy]] rule 2: it is Bearer's own action for the
  scanner this gate runs, it is pinned by SHA to the commit
  scarif-worker's `security.yml` already uses
  (`828eeb928ce2f4a7ca5ed57fb8b59508cb8c79bc`, v2), and `bearer` is added
  to the `allowlist` in `action-security.yml` with a note.
- Waivers live in `bearer.ignore` at the repository root, keyed by
  Bearer's finding fingerprint. Every entry carries a written `comment`
  naming where the flagged input comes from and why it is not
  exploitable. `false_positive: true` means the finding is wrong;
  `false_positive: false` means the risk is real but accepted, and the
  comment names the condition that would reopen it. A waiver without a
  reason is not accepted in review.

## Consequences

- A new critical or high finding fails the PR that introduces it; it
  must be fixed or waived with a reason a reviewer can read.
- Fingerprints are positional within a file for the same rule (`_0`,
  `_1`). An edit that adds or reorders a flagged call in an already
  flagged file can renumber them, turning the job red until
  `bearer.ignore` is refreshed. That is intended: the reviewer looks
  again.
- The action does not pin a Bearer CLI version (its `version` input is
  left at its default), so a newer CLI may bring new rules and fail a PR
  that changed nothing relevant. Such a finding is triaged like any
  other.
- The bearer job is not yet a required status check; making it one is a
  branch-protection setting on `main`, outside this change.

## Alternatives considered

- **Add the job to the nightly `security.yml`.** It runs on a schedule,
  not on pull requests, so it would report a finding after merge rather
  than stop it.
- **Install the Bearer CLI with its `curl | sh` installer in a `run:`
  step.** Avoids a third-party action but executes an unpinned remote
  script, which is worse than one SHA-pinned action under 0024.
- **Include `medium`.** scarif-worker scans `critical,high,medium`; the
  ticket asked for critical/high. minifac has no medium findings today,
  so widening the gate later costs nothing.
- **Contain `resolveCwd` to the factory directory.** Would break the
  specified absolute `cwd` (`cwd: "/explicit/path"` in the factory-schema
  spec) without removing any reachable attack, since every input already
  belongs to the operator.
