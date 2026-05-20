## Why

Today every `minifac run` is wrapped in glue: the operator hand-creates a
`git worktree`, hand-edits a per-change factory copy so each node's `cwd`
points at it, and manually prunes worktrees once they accumulate. That
glue is exactly the friction minifac is supposed to absorb. Decisions
[`0009-Worktree-Default`](../../../docs/decisions/0009-Worktree-Default.md)
and
[`0010-Worktree-Cleanup-Hybrid`](../../../docs/decisions/0010-Worktree-Cleanup-Hybrid.md)
bind the answer: minifac owns the [[Worktree]] lifecycle. This change
lands that ownership so `minifac run <brief>` is sufficient — no manual
`git worktree add`, no per-change factory copy, no manual cleanup.

It is also the unlock for everything queued behind it. The
phase-2 brief-authoring helper and the SDD factory's own dogfood loop
both assume worktree-by-default; until this lands the dogfood requires
a custom `examples/sdd-<change>.yaml` per run, which defeats the point
of the brief-driven workflow that the previous phase shipped.

## What Changes

- **NEW** worktree-management capability. `minifac run` SHALL create a
  git worktree at `~/.minifac/worktrees/<repo-hash>-<change>/` (brief
  driven) or `~/.minifac/worktrees/<repo-hash>-<factory>-<timestamp>/`
  (brief-less factory) before scheduling any node. `repo-hash` is a
  stable short hash of the caller repo's absolute path (or
  `git config --get remote.origin.url` when available). The factory
  branch (named after `change`, off `base_branch` from the brief —
  defaulting to caller's HEAD) is created on the worktree. The branch
  and worktree are left in place when the run ends; no auto-merge, no
  auto-delete.
- **NEW** per-change lockfile at
  `~/.minifac/locks/<repo-hash>-<change>.lock` (brief-driven) or
  `~/.minifac/locks/<repo-hash>-<factory>-<timestamp>.lock`
  (brief-less). The lockfile contains the owning PID. Two runs against
  the same key are refused at lock-claim time. Stale locks (PID is no
  longer a live process) are reclaimed automatically. The lock is
  claimed BEFORE the worktree is created and released in a
  `try/finally` on process exit.
- **NEW** `{{ run.cwd }}` template token resolving to the resolved
  worktree path (or `process.cwd()` under `--in-place`). Token
  substitution SHALL apply to every scheduled node's `cwd` field in
  addition to `with.prompt`. The reserved-token surface in the
  factory schema grows to include `{{ run.* }}` alongside
  `{{ brief.* }}`.
- **NEW** `minifac prune` subcommand implementing the hybrid policy:
  worktrees `< 7 days old` are kept regardless of state; `≥ 7 days AND
  branch merged to default branch` are pruned; `≥ 7 days AND
  unmerged` are kept; failed runs (regardless of age) are kept
  indefinitely. Flags: `--all`, `--merged`, `--older-than <duration>`,
  `--failed`. "Merged" detection uses `git branch --merged <default>`
  plus a `git rev-list` heuristic for squash merges. Default branch is
  auto-detected from `origin/HEAD` and overridable in config.
- **NEW** lazy cleanup at the start of every `minifac run` — a cheap
  prunables check (millisecond budget) that auto-removes worktrees
  matching the auto-prune branch of the hybrid policy. If the check
  would be slow, it SHALL be skipped silently and explicit
  `minifac prune` carries the cost.
- **NEW** failed-run journal. For v0 the prune command's "failed"
  status comes from a transitional JSON file at
  `~/.minifac/failed-runs.json` (an append-only record keyed by
  worktree directory name). The runner appends an entry on every
  non-`succeeded` run termination; `prune` reads the file when
  classifying age-eligible worktrees. Phase 3's runs.db replaces this
  file.
- **NEW** `--in-place` flag on `minifac run` that skips worktree
  creation and lockfile claim, running the factory in
  `process.cwd()`. Brief frontmatter MAY also declare
  `mode: in-place` to declare the same intent per-brief. The flag
  takes precedence over a brief-side `mode:` value (both ways set the
  same in-place mode).
- **NEW** optional `~/.minifac/config.yaml` with `worktrees_dir` and
  `locks_dir` keys overriding the defaults. Per-repo
  `.minifac/config.yaml` (inside the caller's repo root) may further
  override `worktrees_dir`. When both are present, the per-repo
  config wins. Both files missing is the normal case.
- **MIGRATED** `examples/sdd.yaml` replaces every per-node
  `cwd: /path/to/target/repo` placeholder with `cwd: "{{ run.cwd }}"`.
  The one-off `examples/sdd-worktree-mode.yaml` shipped to dogfood
  this very change is deleted in the same change (it becomes obsolete
  the moment `{{ run.cwd }}` lands).
- **BREAKING** the canonical SDD factory's per-node `cwd` is no longer
  a hand-edited absolute path. Anyone with a pre-change copy of
  `sdd-<change>.yaml` either deletes it (recommended — the new shape
  doesn't need a copy at all) or rewrites `cwd:` to `"{{ run.cwd }}"`.

## Capabilities

### New Capabilities

- `worktree-management`: worktree creation, per-key lockfile claim and
  release, `~/.minifac/` layout, the failed-run journal, the
  hybrid cleanup policy, the `prune` subcommand, and the lazy-cleanup
  trigger on `minifac run`. Also owns the optional
  `~/.minifac/config.yaml` and per-repo `.minifac/config.yaml`
  configuration.

### Modified Capabilities

- `run-cli`: the `run` subcommand grows worktree-creation and
  lockfile-claim behavior in front of the runner invocation, the
  `--in-place` flag, the brief-side `mode: in-place` enforcement, and
  the lazy-cleanup pre-step. The `prune` subcommand is documented as
  part of the CLI surface and delegates to `worktree-management`.
- `graph-runner`: token substitution extends to each scheduled node's
  `cwd` field. The substitution catalogue gains `{{ run.cwd }}` (and a
  reserved namespace for future `{{ run.* }}` fields). The runner
  SHALL receive the resolved worktree path (or `--in-place` cwd) as a
  new optional `runCwd` argument; when supplied it is the default
  `cwd` for every node whose `cwd` field is absent OR resolves to the
  empty string after substitution.
- `factory-schema`: the reserved-token surface in node fields grows to
  include `{{ run.<field> }}` alongside `{{ brief.<field> }}`. The
  schema documents that `cwd` accepts template tokens with the same
  grammar as `with.prompt`. No new top-level fields.
- `brief-schema`: a new optional frontmatter field `mode: "in-place"`
  is accepted (and the only literal value recognized in v0). Strict
  validation on the literal; permissive-on-extras unchanged.
- `sdd-factory`: every per-node `cwd` in the shipped `examples/sdd.yaml`
  becomes `cwd: "{{ run.cwd }}"`. Structural test for the shipped
  factory asserts the new shape and asserts the placeholder is gone.

## Impact

- `src/runner/substitute.ts`: extend token substitution to a second
  source-of-values (`run.cwd`) and apply to `cwd` in addition to
  `with.prompt`. Tokens left verbatim when no value is in scope (as
  today for unknown brief fields).
- `src/runner/run.ts`: accept an optional `runCwd` and use it as the
  default node `cwd`. The existing `brief` argument continues to
  drive `{{ brief.* }}` substitution; the new path drives
  `{{ run.* }}` substitution.
- `src/worktree/` (new): a single new directory next to `factory/` and
  `brief/`. Modules: `config.ts` (read+merge of optional config files),
  `paths.ts` (`~/.minifac/` resolution + repo-hash), `lock.ts`
  (PID-bearing lockfile claim/release with stale detection),
  `git.ts` (small wrappers around `git worktree add/remove`,
  `git branch --merged`, `git rev-list` squash-merge heuristic,
  `origin/HEAD` detection), `journal.ts` (the transitional
  `failed-runs.json`), `prune.ts` (the hybrid policy implementation
  and the lazy-check entry point). No new package, no new directory
  structure beyond the single `src/worktree/`.
- `src/cli.ts`: the `run` action wraps factory load → lazy prune →
  lock claim → worktree create → `runFactory({…, runCwd})` →
  finally(release+optionally-journal). The new `prune` subcommand
  lives in `src/cli.ts` (one more verb) and delegates to
  `src/worktree/prune.ts`. The `--in-place` flag short-circuits the
  worktree creation path; it still claims a lock (so two in-place runs
  against the same change name are also refused). The brief-side
  `mode: in-place` is honored identically.
- `src/brief/schema.ts`: add the optional `mode` field with literal
  `"in-place"` validation.
- `examples/sdd.yaml`: replace each `cwd: /path/to/target/repo` with
  `cwd: "{{ run.cwd }}"`.
- `examples/sdd-worktree-mode.yaml`: delete (transitional dogfood
  copy; obsoleted by this change).
- `docs/concepts/Factory.md`: add a section describing the templating
  tokens (`{{ brief.* }}` + `{{ run.* }}`) and the fields they apply
  to (`with.prompt`, `cwd`).
- `src/factory/sdd-example.test.ts`: assert new `cwd` shape on each
  node; assert no placeholder remains.
- New tests under `src/worktree/` cover: repo-hash stability,
  lockfile claim/refuse/stale-reclaim, worktree create + cleanup,
  hybrid prune policy edges (just-under-7d, just-over-7d merged vs
  unmerged, failed runs never auto-pruned), lazy-check budget skip.
- New tests under `src/runner/` cover `{{ run.cwd }}` substitution
  in `cwd` and `with.prompt`, default-cwd fallback when the field
  is absent.
- New tests under `src/cli/` cover `--in-place` short-circuit,
  brief `mode: in-place`, and `minifac prune` flag combinations.
- No new runtime dependencies. Git operations shell out via
  `child_process` (already used by the executor for `claude`).
  YAML config parsing reuses the existing `yaml` package.
- Out of scope (deferred to later phases per the roadmap):
  - SQLite/Dolt runs.db (failed-run state is the transitional
    JSON file)
  - factory composition (`extends:`)
  - brief-authoring helper / Claude Code skill
  - daemon HTTP API changes
