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
| CWE-22 path traversal (high) | `src/runner/run.ts` `resolveCwd` | Accepted by design: the factory-schema spec accepts any node `cwd`, absolute included; every input is the operator's own. For `minifac serve` that holds only since the daemon refuses foreign `Host` and `Origin` headers and non-JSON POSTs (below). |
| CWE-22 path traversal (high) | `src/runner/run.ts` `buildMissingList` | False positive: builds a diagnostic string only; no filesystem access. `filename` cannot contain a separator (`OutputFileSchema`). |
| CWE-22 path traversal (high) | `src/serve/factories.ts` `FactoryWatcher.rescan` | False positive: `name` is a `readdir` entry filtered by `YAML_RE`. |

The full justification for each is the `comment` of its entry in
`bearer.ignore`.

The `resolveCwd` waiver first rested on `POST /api/runs` being reachable
only by the operator because `minifac serve` binds loopback. A loopback
bind does not stop a web page the operator visits: a cross-origin
`text/plain` POST needs no CORS preflight, and a DNS-rebinding page
reaches the daemon under its own host name. The daemon checked neither,
so such a page could start an operator factory in a `cwd` of its
choosing. The security review of this change reproduced it (`201`).
The daemon now refuses those requests (see Decision), which makes the
waiver's premise true.

## Decision

- `.github/workflows/bearer.yml` runs `bearer scan . --scanner
  sast,secrets --severity critical,high` on every pull request to `main`
  and every push to `main`, with `permissions: contents: read`. A finding
  at those severities that `bearer.ignore` does not waive fails the job.
- The CLI is the `bearer_<version>_linux_amd64.tar.gz` asset of a pinned
  Bearer release (`BEARER_VERSION`, 2.1.1), downloaded from its
  `releases/download/v<version>/` URL and checked with `sha256sum -c`
  against a digest hard-coded in the workflow (`BEARER_SHA256`, taken
  from that release's `checksums.txt`) before it is unpacked. A swapped
  or tampered tarball fails the job. The scan step's environment holds
  no token, and `actions/checkout` runs with `persist-credentials: false`,
  so the binary has no GitHub credential to read. No third-party action is
  used, so `action-security.yml`'s allowlist stays `twinsunllc` only.
- `minifac serve` refuses, before routing, a `Host` that is not
  `127.0.0.1`, `localhost` or `[::1]` at the bound port (`403`), and on
  any method other than `GET`/`HEAD` an `Origin` other than its own
  loopback origin (`403`). `POST /api/runs` refuses a `Content-Type` other
  than `application/json` (`415`). See the `serve-daemon` spec,
  "Localhost-only security posture".
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
- The CLI version, and so its rule set, changes only when a PR bumps
  `BEARER_VERSION` and `BEARER_SHA256` together. A new rule cannot red an
  unrelated PR; it surfaces in the bump PR, where it is triaged like any
  other finding.
- The digest guards against the release asset changing after it was
  pinned. It does not vouch for the release itself: a malicious 2.1.1
  published by Bearer would pass. Bumping the pin is a review decision.
- A PR can edit `bearer.yml` or add its own `bearer.ignore` entry, since
  `pull_request` runs the PR's own workflow. The gate catches honest
  mistakes; a deliberate bypass is visible in the diff and is a reviewer's
  call.
- The bearer job is not yet a required status check; making it one is a
  branch-protection setting on `main`, outside this change.

## Alternatives considered

- **Add the job to the nightly `security.yml`.** It runs on a schedule,
  not on pull requests, so it would report a finding after merge rather
  than stop it.
- **`bearer/bearer-action`, SHA-pinned (as scarif-worker's
  `security.yml` uses it, `828eeb9`).** This change first shipped with it.
  The SHA pin covers only the action's wrapper. Its first step runs
  `curl -sfL https://raw.githubusercontent.com/Bearer/bearer/main/contrib/install.sh
  | sh`, a script fetched from a mutable branch. With `version` unset it
  installs whatever release is latest (CI got 2.1.1 while local triage
  used 2.0.2), and its scan step passes `GITHUB_TOKEN` to the downloaded
  binary. Setting `version` would pin the CLI but still run `install.sh`
  from `main` and would still need the 0024 rule 2 exception, so it was
  rejected for the pinned, digest-checked download.
- **Bearer's `curl | sh` installer in a `run:` step.** Same unpinned
  `install.sh` from `main`, without the action's wrapper.
- **Include `medium`.** scarif-worker scans `critical,high,medium`; the
  ticket asked for critical/high. minifac has no medium findings today,
  so widening the gate later costs nothing.
- **Contain `resolveCwd` to the factory directory.** Would break the
  specified absolute `cwd` (`cwd: "/explicit/path"` in the factory-schema
  spec). The reachable attack, a foreign web page driving
  `POST /api/runs`, is closed at the daemon instead, where it applies to
  every route.
