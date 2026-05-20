---
tags: [living-doc]
---

# Roadmap

Current proposal sequence and status. Living doc — updated as
proposals land, get archived, or get deferred.

## Phase 1 — Keystone (ship first)

- [ ] **`factory-inputs`** — decouples per-change data from factory
  infrastructure. Establishes the [[Brief]] as a first-class
  artifact, the new verb shape, brief-less factory support, and
  moves [[Sentinel]] mechanics from per-factory boilerplate into the
  [[Runner]]. SDD factory migrated to consume briefs.
  Key decisions: [[0004-Factory-vs-Input-Separation]],
  [[0005-Brief-Schema]], [[0006-Verb-Shape]],
  [[0007-Sentinel-Runner-Injects]].

## Phase 2 — Ergonomics (either order)

- [ ] **`worktree-mode`** — minifac owns [[Worktree]] lifecycle.
  Per-change-name lockfile, hybrid cleanup policy, `minifac prune`.
  Decisions: [[0009-Worktree-Default]], [[0010-Worktree-Cleanup-Hybrid]].

- [ ] **`brief-authoring`** — Claude Code skill (and/or CLI verb)
  that does one-question-at-a-time refinement of vague intent into a
  structured [[Brief]] under `inputs/<change>.md`.

## Phase 3 — Per-repo + persistence (either order)

- [ ] **`factory-composition`** — `.minifac/factories/<name>.yaml`
  with `extends:`. The per-repo customization story.
  Decision: [[0008-File-Per-Factory-Composition]].

- [ ] **`run-history-persistence`** — [[Runs-DB]] at `~/.minifac/runs.db`.
  Daemon and viewer read prior runs from there. Designed to extend
  for brief state later. Decision: [[0011-SQLite-for-Runs]].

## Phase 4 — Cost optimization (when API spend matters)

- [ ] **`shell-executor`** — drop-in [[Executor]] for verify nodes.
  Cuts cost significantly because no Claude session is spawned for
  "run npm test."

## In-flight

- **`serve-and-viewer-fixes`** — code-review must-fix items (SIGINT
  closes SSE streams, `Last-Event-ID` NaN handling). Being dogfooded
  on the `serve-and-viewer-fixes` branch.

## Already landed (newest first)

- ✅ `sdd-factory-archive-commits` — [[SDD-Loop]]'s archive node self-commits
- ✅ `sdd-factory-uses-claude-controls` — SDD nodes opt into `bypass_permissions` + sentinel
- ✅ `claude-executor-authority-and-status` — `permission_mode`, `allowed_tools`, `add_dirs`, sentinel-based status
- ✅ `serve-and-viewer` — daemon + viewer + SSE (pending merge to main)
- ✅ `sdd-factory` — canonical SDD factory shipped
- ✅ `core-graph-runner` — v0 runnable slice (factory schema, runner, claude executor, run CLI)

## Deferred (see [[Open-Questions]] for triggers)

Each proposes itself when its named trigger fires. Resist pulling forward.

- `hook-status-signaling` — Stop-hook enforcement of [[Sentinel]]
- `callback-status-signaling` — HTTP/MCP endpoint, bidirectional
- `brief-deps-and-state` — `depends_on` in briefs + state in [[Runs-DB]]
- `auto-mode` — long-running minifac process picking up ready work
- `beads-integration` — alternative state substrate
- `pluggable-runners` — formal [[Executor]] interface for a real second runner
- `dolt-adapter` — git-versioned [[Runs-DB]]
- `factory-registries` — multi-repo sharing of custom factories
- `remote-ci-watch` — opt-in verify mode polling GitHub Actions
- `serve-and-viewer-hardening` — heartbeat, safe-root cwd, traversal hardening, host-header
- `trigger-mechanisms` — daemon-side cron, webhooks, file watchers
