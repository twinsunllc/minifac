---
tags: [living-doc]
---

# Roadmap

Current proposal sequence and status. Living doc — updated as
proposals land, get archived, or get deferred.

## Strategic direction

minifac is heading toward **open-source readiness** as the next
big milestone. Concretely that means: a license, an install path,
user-facing docs, and (most importantly) a story that justifies
why anyone else would care.

The pitch is **structured, repo-rooted agent workflows scoped to
a single codebase**, with a small core, plain naming, and
spec-driven development from day one. Factories define structure,
briefs supply intent, [[Studio]] eventually provides inspection
+ chat.

## In-flight

(none — repo is in a clean state, ready to tag v0.1.0)

## Briefs queued ready-to-run

These have ADRs + brief markdown committed; just need a `minifac
run <change>` to start. Listed roughly in suggested order; nothing
enforces this beyond explicit `depends_on` fields.

- [ ] **`callback-status-signaling`** *(design-pending — see
  [[Open-Questions]] § "Callback intervention surface")* —
  [[0017-Callback-Status-Signaling]]. Originally proposed as a
  combined transport for structured outputs + bidirectional
  intervention. The outputs half split off into [[0027-Node-Outputs]]
  with MCP as the transport. What remains for this brief is the
  intervention surface only, and it needs a re-scoped design
  before the brief is runnable. **Blocked from autorun via a
  sentinel `depends_on` entry; clear the dep when the design lands.**

## Open-source readiness (chore tier)

Concrete prerequisites for actually open-sourcing the engine.
Mostly done outside the factory — the work is files, not behavior.

- [x] **LICENSE** — MIT (Jami Couch, 2026)
- [x] **CHANGELOG.md** — Keep-a-Changelog format, 0.1.0 entry
      reflects the full shipped feature surface
- [x] **CONTRIBUTING.md** — short dev-loop guide + SDD pointer +
      `pinact` + dependency-cooldown discipline notes
- [x] **package.json polish** — license, repository, homepage,
      bugs, keywords, author, version bumped to 0.1.0
- [x] **CI for the repo itself** — `.github/workflows/`:
      `ci.yml` (build/test/lint, **matrix on Node 22 + 24**),
      `dependency-review.yml` (PR gate), `security.yml` (nightly
      `npm audit`), `codeql.yml` (JS/TS static analysis),
      `release.yml` (tag-triggered npm publish with OIDC trusted
      publisher + provenance). All actions SHA-pinned per
      [[0024-CI-Security-Policy]].
- [x] **`.npmrc`** — `min-release-age=3` enforces the 3-day
      supply-chain cooldown locally at resolve time, complementing
      the CI lockfile gate (`scripts/check-dep-freshness.mjs`).
- [x] **`.nvmrc`** — Node 24 (Active LTS) for fresh contributors;
      `engines.node` floor stays at 22 (Maintenance LTS).
- [x] **Polished user-facing README** — first-30-seconds
      compelling, leads with `npx minifac run hello` smoke test,
      consolidates feature inventory into CHANGELOG.
- [x] **Install path proof** — `cli-symlink-main-guard` +
      `bundle-builtins` shipped; smoke-tested end-to-end via
      `npm pack` + fresh install in `/tmp`. `npx minifac` works.
- [ ] **First `npm publish`** — one-shot manual publish from a
      trusted machine for v0.1.0 (per [[0026-Release-Pipeline]]),
      then tag-triggered automation takes over via `release.yml`.
- [ ] **Flip repo public** — toggle visibility on GitHub once
      v0.1.0 is published to npm.
- [ ] **Public-friendly examples** beyond the SDD loop (e.g.,
      `examples/factories/code-review.yaml`,
      `dependency-bump.yaml`). Unblocked now that node-outputs
      has landed; probably worth its own brief. v0.2 candidate.

## Already landed (newest first)

- ✅ `brief-cleanliness-gate` — autorun unconditionally skips
  uncommitted briefs with `unclean` skip reason; one-shot
  `minifac run` warns + pauses 3s, opt-in `--require-clean` for
  strict use; recursive ancestor check; non-git degrade. See
  [[0033-Brief-Cleanliness-Gate]].
- ✅ `node-outputs-mcp` — per-run inline MCP server exposing
  typed `mcp__minifac__report_<key>` tools per node's declared
  `value` outputs; `supportsMcp` capability flag with filesystem
  fallback. See [[0029-Node-Outputs-MCP]].
- ✅ `node-outputs-nudge` — single-turn recovery loop when
  required outputs missing after `succeeded` sentinel; default
  budget 1. See [[0028-Node-Outputs-Nudge]].
- ✅ `node-outputs` — per-node `outputs:` declaration with three
  types (`value`, `file`, `directory`); storage outside the
  worktree; post-execution validation; template substitution.
  See [[0027-Node-Outputs]].
- ✅ `autorun-failure-backoff` — per-session failure cap on
  `minifac autorun` (default 3); restart-to-reset.
  See [[0031-Autorun-Failure-Backoff]].
- ✅ `autorun-auto-merge` — autorun merges run-scoped branches on
  successful completion, halts on conflict.
- ✅ `autorun-orphan-recovery` — autorun reconciles `running` rows
  in `runs.db` via lockfile probe; killed-runner cleanup.
- ✅ `autorun-tui` + `autorun-tui-fixes` + `autorun-tui-fixes-2`
  + `autorun-tui-skip-no-clobber` — TUI for `minifac autorun`
  showing per-brief embedded run state, scheduling decisions,
  and skip reasons.
- ✅ `bundle-builtins` — ship `examples/` in the npm tarball;
  resolver finds `minifac:*` references in the installed
  package directory. See [[0030-Bundle-Builtins]].
- ✅ `cli-symlink-main-guard` — realpath-aware `isMain` guard;
  `npm link` / `npx minifac` now work. See
  [[0023-CLI-Symlink-Main-Guard]].
- ✅ `vitest-3-upgrade` — vitest 2.x → 3.x; cleared 5 moderate
  audit findings. See [[0025-Vitest-3-Upgrade]].
- ✅ `auto-mode` — long-running `minifac autorun` polls
  `inputs/` for ready briefs and schedules them; depends_on
  resolution drives the queue order
- ✅ `factory-override-at-invocation` — `--factory <name>` flag
  on `minifac run`; lockfile widens to (change, factory); A/B
  factory comparisons unlocked
- ✅ `reusable-steps` — steps as first-class, versioned,
  typed-input artifacts; nodes reference via `uses:`; the
  "GitHub Actions for factories" piece
- ✅ `run-tui-bounded-borders` — bounded-height
  (`floor(rows/2)`) bordered layout for the TUI; vertical rule
  between status/log; flicker resolved
- ✅ `run-tui` — default TUI for `minifac run` via `ink`; two-pane
  layout, `m` hotkey for inline merge, auto-fallback to raw on
  non-TTY
- ✅ `brief-deps-and-state` — two-axis state model (git for
  briefs, sqlite for runs); `depends_on` + cycle detection;
  `minifac briefs` CLI; minifac-owned mark-done post-step
- ✅ `run-scoped-branches` — branches named `run/<change>-<slug>`;
  worktrees mirror; `branch_name` column in runs.db; `minifac
  merge` ship verb; prune deletes branches it owns
- ✅ `structured-prior-results` — runner passes structured per-node
  results instead of full event history; context-window pressure
  resolved
- ✅ `run-history-persistence` — SQLite at `~/.minifac/runs.db`;
  viewer shows recent runs; runs survive daemon restarts
- ✅ `factory-composition` — `.minifac/factories/` with `extends:`;
  per-repo customization story
- ✅ `brief-authoring` — Claude skill + `minifac brief` CLI
- ✅ `worktree-mode` — minifac owns worktree lifecycle; auto-create,
  cleanup, lockfile, `minifac prune`
- ✅ `factory-inputs-core` — briefs as first-class inputs; new verb
  shape; sentinel runner-injection migrated
- ✅ `runner-sentinel-injection` — sentinel mechanics live in the
  runner, not in factory boilerplate
- ✅ `sdd-factory-archive-commits` — SDD archive node self-commits
- ✅ `sdd-factory-uses-claude-controls` — SDD nodes opt into
  `bypass_permissions` + sentinel
- ✅ `claude-executor-authority-and-status` — `permission_mode`,
  `allowed_tools`, `add_dirs`, sentinel-based status
- ✅ `serve-and-viewer` + `serve-and-viewer-fixes` — daemon + viewer
- ✅ `sdd-factory` — canonical SDD factory shipped
- ✅ `core-graph-runner` — v0 runnable slice

## Deferred (each proposes itself when its trigger fires)

See [[Open-Questions]] for the named triggers.

### Capability gaps

- `shell-executor` — drop-in for verify nodes; cuts cost
- `hook-status-signaling` — Stop-hook enforcement (subsumed by
  callback for the active surface, but a worthwhile incremental
  hardening of sentinel-fallback)
- `dolt-adapter` — git-versioned runs.db (probably never)
- `beads-integration` — alternative state substrate
- `remote-ci-watch` — opt-in verify mode that polls GitHub Actions
- `serve-and-viewer-hardening` — heartbeat, safe-root, etc.
- `trigger-mechanisms` — daemon-side cron/webhook/file-watch
- `step-marketplace` — registry for cross-repo step sharing
- `tui-for-daemon-runs` — observing daemon-mode runs from the
  terminal (the web viewer is the path for now)

### Studio (deliberately separate project)

[[Studio]] is the eventual visual + chat surface for minifac —
not a minifac engine feature. Will be developed in a separate
repo (`minifac-studio/`) consuming the daemon's HTTP API.

**Direction: lean into chat-with-a-run, skip the visual builder.**
A visual factory designer alone is a crowded space minifac would
enter with the fewest integrations. The interesting paradigm is
*chat anchored to a structured run* — postmortem ("why did this
fail?"), mid-run steering ("hey, also do X"), inspection ("walk
me through what happened on the verify retry"). YAML stays the
source of truth for authoring; visual surfaces are for inspection
and conversation.

**Packaging: separate repo, not a workspace.** The engine ↔
Studio boundary is the daemon's HTTP API. Shared TS types travel
via a published types package, not a monorepo. Stance gets
revisited if cross-cutting engine+Studio changes become frequent
enough to feel painful.

Studio's plausible v1 features (when we get there):
- Run inspector (visual replay of runs.db)
- Chat with a finished run (postmortem)
- Chat with a running node (depends on
  `callback-status-signaling`)
- Brief authoring as a guided UI flow

Visual factory designer is **not** a v1 goal. The pitch is "chat
anchored to a structured run," not "yet another visual workflow
builder."

The TUI's event-reducer (from `run-tui`) is a pure function and
can later feed Studio's render pipeline. Sharing that logic is
the natural seam if/when studio starts.
