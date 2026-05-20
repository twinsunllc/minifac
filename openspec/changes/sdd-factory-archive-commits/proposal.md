## Why

The shipped SDD factory at `examples/sdd.yaml` runs `openspec archive
<change>` in the `archive` node. That command moves the change
directory from `openspec/changes/<change>/` to
`openspec/changes/archive/<dated>-<change>/` and folds the change's
spec deltas into `openspec/specs/<capability>/`. Those are real file
moves and content rewrites in the target repo's working tree.

The first real end-to-end dogfood run (commit `fcc3985` on the
`serve-and-viewer` branch) exposed the gap: `archive` exited 0, emitted
`MINIFAC_STATUS: succeeded`, and the run ended — but every archive
artifact was sitting uncommitted in the working tree. A human had to
discover this after the fact and craft the archive commit by hand.

This breaks the contract the SDD factory is supposed to provide. The
factory exists to drive a complete propose → apply → verify → archive
loop. Leaving an unreviewed git diff on disk at the end is not
"complete" — the next factory invocation against the same repo would
inherit a dirty tree and any human stepping in afterward has to
reverse-engineer the intent of the diff. The other write-producing
nodes (`propose`'s artifacts and `apply`'s code changes) already get
committed: `apply`'s prompt explicitly says "Commit progress when it
makes sense; do not push," and `propose`'s scaffolded files ride
along inside `apply`'s commit. Only `archive`'s output was left
homeless.

## What Changes

- The `archive` node's prompt in `examples/sdd.yaml` is rewritten so
  that, after `openspec archive <CHANGE_NAME>` exits 0 and before the
  node emits its `MINIFAC_STATUS: succeeded` sentinel, the prompt
  instructs the model to stage and commit the archive moves with
  `git add -A` followed by `git commit -m "Archive: <CHANGE_NAME>"`
  (with a 2–3 line body summarising what was folded into canonical
  specs and which change directory was moved). The commit message
  body SHALL end with the existing repo convention
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- The prompt SHALL explicitly forbid the commit when the prior
  `openspec archive` invocation exits non-zero, and SHALL treat a
  failed `git commit` (e.g. pre-commit hook rejection) as a node
  failure, emitting `MINIFAC_STATUS: failed` with a `REASON:` line
  naming whichever step (the archive or the commit) broke.
- The canonical `sdd-factory` spec is updated. The existing
  "SDD factory per-node responsibility" requirement is **MODIFIED**
  so that the `archive` bullet binds the commit step: archive SHALL
  drive `openspec archive <name>`, SHALL commit the resulting moves
  with subject `Archive: <name>` only on a clean archive exit, and
  SHALL emit `MINIFAC_STATUS: succeeded` only when both steps
  succeed. Two new scenarios cover the success and failure paths of
  the commit step.
- `examples/sdd.md` documents the commit step in the `archive`
  section of the per-node contract and in the "Status signaling"
  language, calling out the subject-line convention and the
  ordering constraint (archive first, then commit, then sentinel).
- `src/factory/sdd-example.test.ts` gains an assertion that the
  `archive` node's prompt contains the literal substring `git commit`
  (and, more specifically, the substring `Archive:` to nail down the
  subject-line convention). The existing eight tests continue to
  pass unchanged.

Explicitly **out of scope** (each is a future proposal if/when
justified):

- Making `propose` produce its own commit separately from `apply`.
  The existing pattern — `apply` bundles `propose`'s scaffolded
  artifacts into its commit — is intentional and works fine.
- Making `verify` commit. `verify` is read-only; there is nothing
  to commit.
- Multi-step commits inside `apply`. `apply`'s prompt already says
  "Commit progress when it makes sense"; that suffices.
- Pushing to a remote. The factory never pushes; humans push.
- Configuring git identity, signing, or pre-commit hook policy. The
  factory inherits whatever the user has configured in the target
  repo.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `sdd-factory`: the canonical SDD capability is updated so the
  `archive` node's per-node contract mandates a `git add -A` /
  `git commit -m "Archive: <name>"` step in between a clean
  `openspec archive` exit and the success sentinel. One existing
  requirement (per-node responsibility) is rewritten; two new
  scenarios are added under it.

## Impact

- `examples/sdd.yaml` and `examples/sdd.md` are the only repo-shipped
  factory artifacts that change. `src/` changes are limited to one
  new assertion in the existing structural test.
- No new runtime dependencies. No `package.json` changes.
- The `node-executor` and `factory-schema` canonical specs are **not**
  touched. The new behaviour is entirely prompt-level; the executor
  surface stays as-is.
- Users who copied `examples/sdd.yaml` before this change retain the
  pre-change archive prompt. Their factories will continue to leave
  archive artifacts uncommitted until they merge the new prompt
  shape into their copies; the migration note in `examples/sdd.md`
  tells them how.
