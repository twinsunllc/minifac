# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Library namespace with pinned fetch-at-ref resolution** (#44, #47,
  [ADR 0039](docs/decisions/0039-Library-Namespace.md)). A project pins
  one library with `library: { repo, ref }` in `factory.yaml` or
  `.minifac/config.yaml`; `extends: library:<name>` resolves the
  library's `workflows/<name>.yaml` at the pin and `uses: library:<name>`
  its `steps/`. Bare `uses:` resolves local → library → built-in. A
  factory repo (one with `factory.yaml`) gets root `steps/` and
  `workflows/` as its local layer. Only a tag or a full 40-character sha
  is an acceptable pin; branches, abbreviated shas, `HEAD`, `refs/…` and
  revision expressions are refused naming the ref, a moved tag is
  refused, and a stale pin fails naming the library's current head and
  latest tag. Libraries are cached as a bare mirror plus one
  content-addressed tree per sha under `$MINIFAC_HOME/cache/library/`,
  refreshed on every load and tolerated offline with a
  `MINIFAC_LIBRARY_OFFLINE` warning. `runs.db` schema v5 records
  `library_repo` / `library_ref` / `library_sha` on each run (one-way
  migration from v4), surfaced by `minifac runs --json`.
- **Cross-node session resume with model override** (#31,
  [ADR 0035](docs/decisions/0035-Cross-Node-Session-Resume.md)). A node
  MAY declare `resume: <node-id>`; the runner dispatches it with
  `--resume <that node's latest session id>` and this node's
  `with.model`, so a continuation inherits the prior node's full
  in-context history. The two nodes must share `cwd`; an unsatisfiable
  resume fails the dispatch before spawning. `runs.db` schema v4 records
  `node_executions.session_id`.

### Fixed

- A `{{ priorResults.* }}` token passed through a `uses:` node's
  `inputs:` was erased to `""` at load time; load-time substitution now
  resolves `inputs.*` only and leaves other namespaces for dispatch
  (#33, #45).
- An `extends:` layer that overrides a node the base does not declare
  is a load error naming the layer and the base's nodes, unless the same
  layer's `edges:` wires the new node in (#34, #46). Previously the
  orphan node was added silently and, having no inbound edge, started at
  run begin.
- Pinned `fast-uri` to 3.1.7 to clear four high advisories
  (GHSA-5jgf-p345-68v8 and related) within the dependency cooldown (#32).

## [0.1.2] — 2026-06-18

### Security

- Cleared all `npm audit` findings (was 1 critical, 3 high, 1 low).
  Bumped `vitest` to `^4.1.8` (drops the vulnerable transitive
  `esbuild`), pinned `hono` to `4.12.25` (patched production
  dependency) and `nanoid` to `3.3.12` via `overrides`; `ws` resolves
  to `8.21.0`. `npm audit --audit-level=high` now exits clean and the
  dependency-freshness gate stays green.
- Added the `action-security` CI workflow: every push and PR now runs
  `twinsunllc/github-actions-security-checker` (SHA-pinned to v1.4.3)
  to enforce SHA-pinning and verified publishers across
  `.github/workflows`. See
  [`0034-Action-Pinning-Enforcement`](docs/decisions/0034-Action-Pinning-Enforcement.md).

## [0.1.1] — 2026-05-22

Initial public release.

### CLI

- `minifac init [--with-sdd]` — bootstrap `inputs/`, `.minifac/`, and
  (optionally) a starter SDD factory in the current repo
- `minifac run <change>` — execute a factory against a brief; default
  bounded-height TUI, `--raw` for pipes / CI, `--in-place` to skip
  worktree creation, `--factory <name>` to override the brief's
  declared factory, `--force` to override blocked-deps refusal
- `minifac brief <change>` — interactive brief authoring
- `minifac autorun` — long-running daemon that polls `inputs/` and
  dispatches ready briefs as they appear
- `minifac serve [dir]` — local web viewer at `http://127.0.0.1:4280`
  (localhost-only, no auth)
- `minifac runs [show <id>]` — query the run history persisted to
  `~/.minifac/runs.db`
- `minifac merge <change|run-id>` — fast-forward (or any-merge) a
  finished run's branch back into the base
- `minifac briefs` — see what's queued, blocked, ready, running, done
- `minifac prune` — reclaim disk from finished worktrees and outputs
- `minifac steps` — list reusable steps in scope

### Runtime

- Fresh git worktree per run at `~/.minifac/worktrees/`
- Run-scoped branches: `run/<change>-<slug>`
- Structured event log persisted to SQLite, replayable after the fact
- Claude executor with streaming output and sentinel-based
  success/failure signaling
- Two-pane interactive TUI by default for both `minifac run` and
  `minifac autorun`
- Bundled `hello.yaml` (one-node smoke test) and `sdd.yaml` (the
  spec-driven loop)
- Factory composition via `extends:` and reusable steps via `uses:`
- Dependent briefs (`depends_on:` in frontmatter) with cycle detection

### OSS infrastructure

- MIT licensed (`LICENSE`)
- Contribution guide (`CONTRIBUTING.md`)
- GitHub Actions for CI, dependency review, scheduled npm audits,
  and CodeQL — all actions SHA-pinned per
  `docs/decisions/0024-CI-Security-Policy.md`
- CI rejects dependencies published less than 3 days ago
  (`scripts/check-dep-freshness.mjs`)
- npm publish gated through OIDC trusted publisher with provenance

[Unreleased]: https://github.com/twinsunllc/minifac/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/twinsunllc/minifac/releases/tag/v0.1.1
