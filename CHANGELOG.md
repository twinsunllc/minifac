# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- OSS-readiness scaffolding: `LICENSE` (MIT), `CONTRIBUTING.md`, this
  `CHANGELOG.md`, and an initial `.github/workflows/` set covering CI,
  dependency review, scheduled npm audits, and CodeQL.
- `docs/decisions/0024-CI-Security-Policy.md` capturing the
  SHA-pinning + verified-publisher policy for GitHub Actions.

## [0.1.0] — TBD

Initial public release. Features at this snapshot:

- Graph-based factory runner with cycles and `on_failure` recovery
- Brief authoring (`minifac brief`), dependency tracking, two-axis
  state model (git for briefs, SQLite for runs)
- Run-scoped branches + `minifac merge` ship verb
- Default TUI for `minifac run` (bounded-height, bordered layout)
- Factory composition via `extends:` and reusable steps via `uses:`
- Daemon + web viewer (`minifac serve`)

[Unreleased]: https://github.com/twinsunllc/minifac/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/twinsunllc/minifac/releases/tag/v0.1.0
