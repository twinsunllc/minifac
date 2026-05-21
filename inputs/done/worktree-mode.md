---
change: worktree-mode
factory: sdd-worktree-mode
base_branch: main
---

## Background

Today the user (or Claude Code acting as glue) manually creates a `git worktree`
before invoking minifac, sets the factory's `cwd` to the worktree path by
hand-editing a per-change factory copy, and prunes worktrees manually. That
glue is exactly the kind of friction minifac is supposed to absorb. See
`docs/decisions/0009-Worktree-Default.md` and
`docs/decisions/0010-Worktree-Cleanup-Hybrid.md` for the binding decisions.

This change makes minifac own the worktree lifecycle so a `minifac run`
invocation is sufficient — no manual `git worktree add`, no per-change factory
copy, no manual cleanup.

## What to do

Read first:

- `docs/decisions/0009-Worktree-Default.md` — worktree default behavior, location, lockfile model
- `docs/decisions/0010-Worktree-Cleanup-Hybrid.md` — cleanup policy and `minifac prune`
- `docs/concepts/Worktree.md` — concept-level overview
- `docs/concepts/Run.md` and `docs/concepts/Runner.md` — how runs interact with worktrees
- Existing canonical specs at `openspec/specs/` — especially `run-cli/spec.md`, `graph-runner/spec.md`, `factory-schema/spec.md`

Then implement what the decisions describe. Concretely:

### 1. Worktree creation on `minifac run`

- When the user invokes `minifac run <brief>` (brief-driven, not brief-less),
  minifac SHALL create a git worktree at
  `~/.minifac/worktrees/<repo-hash>-<change>/` from `base_branch`
  (from the brief; defaults to caller's HEAD).
- `repo-hash` is a stable hash derived from the calling repo's absolute path
  (or remote URL if available) so two repos with the same change name don't
  collide.
- A branch named after `change` is created on the worktree (off `base_branch`).
- The runner uses the worktree path as the *default* cwd for every node in
  the factory (overriding any factory-level cwd placeholder). Per-node `cwd`
  in the factory definition still wins if explicitly set to a non-placeholder
  value — but it MUST also support templating (see below).
- Brief-less factory invocations (factory declares `brief: none`) SHALL also
  create a worktree by default; the worktree's name is derived from the
  factory name + a timestamp to disambiguate concurrent runs.

### 2. Make cwd templatable

- Today the factory's per-node `cwd` is a literal string. Extend the runner's
  template substitution (`src/runner/substitute.ts`) to ALSO apply to the
  `cwd` field, not just prompts.
- Introduce a templating token for the worktree path:
  `{{ run.cwd }}` resolves to the resolved worktree path for this run.
- Update `examples/sdd.yaml` so each node's `cwd: /path/to/target/repo`
  becomes `cwd: "{{ run.cwd }}"`. Same for any other shipped factory that
  hardcoded a target-repo placeholder.
- Document the templating tokens (`brief.*`, `run.*`) in
  `docs/concepts/Factory.md` and the canonical `factory-schema` /
  `graph-runner` specs.

### 3. Per-change-name lockfile

- A per-change-name lockfile at
  `~/.minifac/locks/<repo-hash>-<change>.lock` SHALL contain the owning
  PID. Two runs against the same change name SHALL be refused at lock-claim
  time.
- Stale locks (PID is no longer a live process) SHALL be reclaimed
  automatically.
- For brief-less factory invocations, the lock key uses the factory name
  plus the timestamp (per worktree naming above).
- Lockfile claim happens BEFORE worktree creation; release happens on
  process exit (best-effort cleanup in a `try/finally`, plus the
  stale-detection as the safety net).

### 4. Cleanup — `minifac prune` command

- New `minifac prune [flags]` CLI subcommand implementing the hybrid policy
  described in `docs/decisions/0010-Worktree-Cleanup-Hybrid.md`:
  - `< 7 days old`: always kept regardless of state
  - `≥ 7 days AND branch merged to default branch`: auto-pruned
  - `≥ 7 days AND branch unmerged`: kept
  - `Failed runs (regardless of age)`: kept indefinitely
- Flags: `--all`, `--merged`, `--older-than <duration>`, `--failed`.
- "Merged" detection uses `git branch --merged <default>` and a
  `git rev-list` heuristic for squash-merges.
- Default branch is auto-detected via `origin/HEAD` or configurable.
- "Failed" status comes from the future runs.db (phase 3); for v0,
  track failed runs in a small JSON file under `~/.minifac/` until the
  proper DB lands. Be clear in the spec that the JSON file is a
  transitional store.

### 5. Lazy cleanup on `minifac run`

- At the start of every `minifac run` invocation, the runner SHALL do a
  cheap pruneables check and remove worktrees that would have been pruned
  by `minifac prune` (per the hybrid policy). Keep this fast — millisecond
  budget; if it would be slow, skip it and rely on explicit `prune`.

### 6. `--in-place` opt-out

- A `--in-place` flag on `minifac run` SHALL run the factory in the
  caller's `process.cwd()` instead of creating a worktree. For CI
  environments or for read-only factories.
- Brief frontmatter MAY also carry `mode: in-place` to declare the same
  intent per-brief.

### 7. Configuration

- Optional `~/.minifac/config.yaml` with `worktrees_dir` and `locks_dir`
  fields overriding the defaults. The CLI reads this at startup; missing
  file is fine.
- Per-repo `.minifac/config.yaml` MAY also override `worktrees_dir`. If
  both are present, repo config wins.

### Spec impact

Probably substantial:

- `run-cli`: MODIFIED requirements for the `run` subcommand (cwd
  resolution behavior, `--in-place` flag) and ADDED requirements for
  `prune`.
- `graph-runner`: MODIFIED requirement for cwd resolution (now sourced
  from worktree path via templating, not from factory file's source
  directory).
- `factory-schema`: ADDED requirement that `cwd` accepts template
  tokens (`{{ run.cwd }}` and possibly `{{ brief.* }}`).
- NEW capability `worktree-management` (or fold into an existing one)
  covering the worktree creation, lockfile, and cleanup machinery.
- `sdd-factory`: MODIFIED requirement(s) so the canonical `examples/sdd.yaml`
  no longer hardcodes a placeholder cwd — it uses `{{ run.cwd }}`.

Use your judgment on the exact spec breakdown. When MODIFYING, copy the
entire requirement block; do not partial-paste.

## Out of scope

- **Run history persistence (SQLite)** — phase 3. For v0, failed-run
  tracking lives in a transitional JSON file under `~/.minifac/`.
- **Factory composition** (`.minifac/factories/<name>.yaml` with `extends:`) —
  phase 3. This change does NOT introduce extends/overrides.
- **Brief-authoring helper** — separate phase-2 proposal coming after this.
- **Daemon/viewer integration** — the daemon already exists; if it needs to
  know about worktrees, that's a small adjustment within scope, but no big
  daemon changes.

## Acceptance criteria

- `minifac run <brief>` creates a worktree, runs the factory there, leaves
  the branch + worktree for the user (no auto-merge, no auto-delete)
- The same brief invoked again concurrently is refused with a clear error
- The same brief invoked again after the prior run finished produces a
  second worktree at a distinct path (some disambiguation, possibly a
  short suffix; if you can avoid collisions cleanly with the lockfile
  alone, fine)
- `examples/sdd.yaml` no longer references `/path/to/target/repo`; uses
  `{{ run.cwd }}`
- `minifac prune` honors the hybrid policy; flags work
- `--in-place` skips worktree creation
- All existing tests still pass; new tests cover worktree creation,
  lockfile semantics, cleanup policy edges, `{{ run.cwd }}` substitution

## Note on this dogfood's setup

This brief is being dogfooded BEFORE `worktree-mode` ships, so the worktree
for this run was created manually and a customized factory copy
(`examples/sdd-worktree-mode.yaml`) was shipped alongside the brief with the
correct hardcoded cwd. That customized factory copy is a one-off; do NOT
treat it as a template for future factory authoring. The whole point of
this change is to make that workaround unnecessary.

When implementing, you MAY remove `examples/sdd-worktree-mode.yaml` as part
of the apply step (it'll be obsolete once `{{ run.cwd }}` lands in
`examples/sdd.yaml`). Or leave it; either is fine. The next dogfood
(`brief-authoring`) will run via the new shape.
