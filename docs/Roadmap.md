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

The differentiation pitch — captured in [[Comparisons]] — is
**structured, repo-rooted agent workflows with mid-run conversation
support**. Not a visual workflow builder (that's n8n's space). Not
a conversational orchestrator (that's gas-city's). Something in
between: factories define structure, briefs supply intent,
[[Studio]] eventually provides inspection + chat.

## In-flight

(none — repo is in a clean state)

## Briefs queued ready-to-run

These have ADRs + brief markdown committed; just need a `minifac
run <change>` to start:

- [ ] **`brief-deps-and-state`** — [[0015-Brief-Deps-and-State]].
  Brief frontmatter gains `depends_on`; brief state is computed
  from file + runs.db; cycle detection; `minifac briefs` CLI.
- [ ] **`auto-mode`** — [[0016-Auto-Mode]]. Long-running `minifac
  autorun` polls inputs/ for ready briefs and schedules them.
  Depends on `brief-deps-and-state`.
- [ ] **`callback-status-signaling`** — [[0017-Callback-Status-Signaling]].
  Opt-in HTTP endpoint per node for bidirectional comms. Unblocks
  mid-run human-in-the-loop and the future [[Studio]] chat surface.

## Queued for next ADR + brief authoring

- [ ] **`reusable-steps`** — [[0018-Reusable-Steps]]. Steps as
  first-class, versioned, typed-input artifacts that nodes can
  reference via `uses:`. "GitHub Actions for factories." Most
  compelling open-source differentiator.

## Open-source readiness (chore tier)

Concrete prerequisites for actually open-sourcing, mostly
non-architectural:

- [ ] LICENSE file (MIT, Apache 2.0, or whatever)
- [ ] Polished user-facing README (current README is honest; needs
      a quickstart that doesn't require reading `docs/`)
- [ ] CONTRIBUTING guide
- [ ] Install path — `npm publish` for the engine; document
      `npx minifac` as the canonical invocation
- [ ] Public-friendly examples beyond the SDD loop (e.g.,
      `examples/factories/spec-drift-watch.yaml`,
      `dependency-bump.yaml`, etc. — earned by reusable-steps)
- [ ] A short "why minifac" pitch document — distilled from
      [[Comparisons]]
- [ ] CI for the repo itself (currently we run verify gates in
      worktrees but have no GitHub Actions configured for the
      project's own development)

## Already landed (newest first)

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

### Studio (deliberately separate project)

[[Studio]] is the visual + chat surface — not a minifac engine
feature. Will be developed in a separate repo (`minifac-studio/`)
consuming the daemon's HTTP API. The decision and rationale live
in [[Comparisons]] under "Studio direction" and "Studio packaging."

Studio's plausible v1 features (when we get there):
- Run inspector (visual replay of runs.db)
- Chat with a finished run (postmortem)
- Chat with a running node (depends on
  `callback-status-signaling`)
- Brief authoring as a guided UI flow

Visual factory designer is **not** a v1 goal. The pitch is "chat
anchored to a structured run," not "yet another visual workflow
builder."
