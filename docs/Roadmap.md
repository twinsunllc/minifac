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

(none — repo is in a clean state)

## Briefs queued ready-to-run

These have ADRs + brief markdown committed; just need a `minifac
run <change>` to start. Listed roughly in suggested order; nothing
enforces this beyond explicit `depends_on` fields.

- [ ] **`bundle-builtins`** — [[0030-Bundle-Builtins]].
  Pre-publish blocker. Ship `examples/` in the tarball and
  teach the resolver to find `minifac:*` references in the
  installed package directory. Today `npx minifac init
  --with-sdd && npx minifac run …` is aspirational — the
  README quickstart doesn't actually work against a fresh
  npm install. Fixes that. Also documents the
  eventual resolver chain in [[Reference]].
- [ ] **`cli-symlink-main-guard`** —
  [[0023-CLI-Symlink-Main-Guard]]. One-line fix: the `isMain`
  guard in `src/cli.ts` compares `import.meta.url` (realpath)
  against `process.argv[1]` (symlink path), so `npm link` /
  `npx minifac` invocations silently no-op. Switch to a
  realpath comparison. Hard prerequisite for the
  open-source-readiness install-path story.
- [ ] **`vitest-3-upgrade`** — [[0025-Vitest-3-Upgrade]].
  Bump vitest 2.x → 3.x to clear 5 moderate-severity audit
  findings in the dev `vite`/`esbuild` chain. Mostly mechanical;
  watch for the new default `threads` pool affecting
  isolation-sensitive tests.
- [ ] **`node-outputs`** — [[0027-Node-Outputs]]. Per-node
  `outputs:` declaration in factory schema, with three types
  (`value`, `file`, `directory`); storage at
  `~/.minifac/outputs/<run-id>/<node-id>/<iteration>/` outside
  the worktree; post-execution validation with
  `missing_required_output` failure reason; template
  substitution via `{{ priorResults.<id>.outputs.<key> }}`;
  CLI surfaces for inspection and pruning. v1 uses filesystem
  JSON transport for `value` outputs. Unblocks fan-in shapes
  like the proposed `code-review.yaml` example.
- [ ] **`node-outputs-nudge`** — [[0028-Node-Outputs-Nudge]].
  Single-turn recovery loop when required outputs missing
  after a `succeeded` sentinel. Default budget 1, opt-out
  with `output_nudge_budget: 0`. Sentinel-failed nodes never
  nudged. `depends_on: [node-outputs]`.
- [ ] **`node-outputs-mcp`** — [[0029-Node-Outputs-MCP]].
  Replace filesystem-JSON transport for `value` outputs with
  an inline MCP server exposing typed tools per declared
  output. File / directory outputs stay filesystem.
  Cross-executor story preserved via a `supportsMcp`
  capability flag with filesystem fallback.
  `depends_on: [node-outputs]`.
- [ ] **`callback-status-signaling`** *(design-pending — see
  [[Open-Questions]] § "Callback intervention surface")* —
  [[0017-Callback-Status-Signaling]]. Originally proposed as a
  combined transport for structured outputs + bidirectional
  intervention. The outputs half split off into [[0027-Node-Outputs]]
  with MCP as the transport. What remains for this brief is the
  intervention surface only, and it needs a re-scoped design
  before the brief is runnable. **Blocked from autorun via a
  sentinel `depends_on` entry; clear the dep when the design lands.**
- [ ] **`autorun-failure-backoff`** —
  [[0031-Autorun-Failure-Backoff]]. Per-session failure cap on
  `minifac autorun` (default 3); skip with `failure-cap` reason
  after N consecutive failures of the same change. Restart of
  autorun resets the counter. Prevents a broken brief from
  hammering the loop indefinitely.

## Open-source readiness (chore tier)

Concrete prerequisites for actually open-sourcing, mostly
non-architectural. Mostly done outside the factory — the work is
files, not behavior. The factory is reserved for the install-path
fix ([[cli-symlink-main-guard]]) and possibly the examples library.

- [x] **LICENSE** — MIT (Jami Couch, 2026)
- [x] **CHANGELOG.md** — Keep-a-Changelog format, scaffolded with
      a TBD 0.1.0 entry
- [x] **CONTRIBUTING.md** — short dev-loop guide + SDD pointer +
      `pinact` discipline note
- [x] **package.json polish** — license, repository, homepage,
      bugs, keywords, author, version bumped to 0.1.0
- [x] **CI for the repo itself** — `.github/workflows/`:
      `ci.yml` (build/test/lint), `dependency-review.yml` (PR
      gate), `security.yml` (nightly `npm audit`),
      `codeql.yml` (JS/TS static analysis). All actions
      SHA-pinned per [[0024-CI-Security-Policy]].
- [ ] **`cli-symlink-main-guard` shipped** — hard prerequisite
      for the install path. Brief queued; tiny dogfood.
- [ ] **Polished user-facing README** — current README is
      honest internal docs; needs a top section that's
      first-30-seconds compelling. Describe what minifac *is*
      and who it's for; resist the urge to enumerate
      competitors (best-in-class OSS READMEs don't).
- [ ] **Install path** — `npm publish` for the engine; document
      `npx minifac` as the canonical invocation. Blocked on
      cli-symlink-main-guard.
- [ ] **Public-friendly examples** beyond the SDD loop (e.g.,
      `examples/factories/spec-drift-watch.yaml`,
      `dependency-bump.yaml`, `code-review.yaml`). Unblocked
      now that reusable-steps has landed; probably worth its
      own brief.
- [ ] *(maybe skip)* A "why minifac" pitch document. The
      README's intro should carry this work. If after the
      README rewrite there's still material that doesn't fit,
      a separate pitch doc can be carved out — but the README
      is the primary surface.

## Already landed (newest first)

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
