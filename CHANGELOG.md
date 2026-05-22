# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — TBD

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

[Unreleased]: https://github.com/twinsunllc/minifac/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/twinsunllc/minifac/releases/tag/v0.1.0
