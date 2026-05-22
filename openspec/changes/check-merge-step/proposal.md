## Why

Factories today have no way to ask "is this branch still cleanly
mergeable against its base?" mid-workflow. The runner can attempt the
merge at the end (per `inputs/autorun-auto-merge.md`), but by then
`apply` and `verify` have already burned cycles on what might be a
doomed change — `main` may have moved underneath the worktree in a
way that guarantees conflicts.

A read-only mergeability probe as a built-in step lets factories
fast-fail when the base has diverged in a conflicting way. It also
lets factories gate "done" on mergeability without actually
performing the merge (the action stays in the runner, per the split
already agreed on in [[autorun-auto-merge]]).

This change is also the foundation for a future cycle-on-conflict
edge story — a factory that routes a conflict back through `apply`
with conflict context — captured in `docs/Open-Questions.md` and
gated on the node-outputs work maturing enough to carry structured
conflict context between iterations. v0 emits a pass/fail signal
only.

## What Changes

- **New built-in executor `check-merge`** registered alongside
  `claude` in the default executor registry. The executor performs a
  read-only mergeability probe of the current worktree's `HEAD` onto
  a configured base branch using `git merge-tree` (with a
  `git merge --no-commit --no-ff` + `git merge --abort` fallback if
  the merge-tree path is unavailable). It emits a final `status`
  event of `succeeded` (clean merge) or `failed` (conflicts, or
  non-fast-forward under `mode: "fast-forward"`). The worktree SHALL
  be byte-for-byte unmodified after the probe in every case (no
  `MERGE_HEAD`, no staged conflict markers, working tree clean,
  index untouched).
- **New built-in step `check-merge`** shipped at
  `examples/steps/check-merge.yaml` per the bundling rules in
  `docs/decisions/0030-Bundle-Builtins.md`. A node references it as
  `uses: minifac:check-merge`. The step declares two optional
  inputs: `base` (string; defaults to the run's configured base
  branch via `"{{ run.base_branch }}"` indirection — see the
  `graph-runner` modified requirement below) and `mode` (string,
  one of `"any-merge"` or `"fast-forward"`; defaults to
  `"any-merge"`).
- **New `{{ run.base_branch }}` template token.** The `graph-runner`
  capability's "Brief token substitution" requirement gains a third
  `run`-scope field, `base_branch`, that resolves at dispatch time
  to the branch the worktree was created from (per
  `worktree-management`). When the run was not worktree-scoped (in-
  place mode), the token resolves to the empty string and the
  check-merge executor SHALL emit a validation failure with a clear
  message — `base` cannot default to nothing.
- **SDD factory adopts the step.** `examples/sdd.yaml` gains a
  fifth node, `check-merge`, that runs after `archive`. The new
  node is `terminal: true`; `archive` is no longer terminal and
  routes to `check-merge` on success. The factory has no
  `on_failure` edge out of `check-merge` in v0 — a conflict ends
  the run as `failed` and the brief stays at `inputs/<change>.md`
  for the operator to resolve (which composes naturally with the
  auto-merge flow filed under [[autorun-auto-merge]]).
- **Composability is preserved.** A factory author MAY drop the
  step anywhere — before `apply` for early fast-fail, after
  `archive` to gate "done", or twice for paranoid factories. The
  step is read-only; running it multiple times in a single graph
  has no side effects beyond the work the probe itself does.

## Capabilities

### New Capabilities

- `check-merge-step`: defines the on-disk shape of the bundled
  `check-merge` step file, the registered `check-merge` executor's
  `with:` schema and behavior contract (mergeability probe rules,
  worktree-clean invariant, exit semantics under each `mode`), and
  the registry-level wiring (the executor SHALL be registered by
  default alongside `claude`; a node that declares
  `executor: check-merge` resolves to it without further setup).

### Modified Capabilities

- `sdd-factory`: MODIFIED to accommodate the new fifth node.
  Topology grows from four nodes to five; `archive` is no longer
  terminal and routes to `check-merge` on success; `check-merge`
  is the sole terminal node. The "Factory uses only the claude
  executor" scenario becomes "Claude-executor nodes use the
  `claude` executor; the check-merge node uses the `check-merge`
  executor", and the authority / prompt / sentinel requirements
  are scoped to the four claude-executor nodes (which is what
  they always meant in practice; check-merge has no prompt and no
  sentinel). `cwd` continues to be `{{ run.cwd }}` on every node
  including check-merge.
- `graph-runner`: MODIFIED the "Brief token substitution"
  requirement to recognize `{{ run.base_branch }}` as a third
  `run`-scope field alongside `cwd` and any existing fields. The
  value SHALL come from the run's configured base branch (the
  branch the worktree was created from per
  `worktree-management`), or the empty string when no base branch
  is available. The substitution rules (out-of-scope → leave
  verbatim, stringification, etc.) are unchanged.

## Impact

- **New code.** `src/executor/check-merge.ts` (the new executor
  type and its `with:` validator), wired into the default registry
  in `src/cli.ts`. A small helper module for the git plumbing
  (`src/executor/check-merge.git.ts` or inlined — implementer's
  choice). `examples/steps/check-merge.yaml` (the new built-in
  step file).
- **Modified code.** `examples/sdd.yaml` gains the fifth node and
  the new edges; `archive.terminal` flips off. The structural test
  (`src/factory/sdd-example.test.ts`) updates for the new
  topology, the new node, the executor-mix assertion, and the
  removed `archive.terminal === true` claim. The runner's
  per-node `cwd` / brief / run substitution module
  (`src/factory/templating.ts`) gains the `base_branch` field on
  the `run` namespace and reads it from the run-options shape.
  `src/runner/run.ts` threads `baseBranch` through `RunOptions`
  so the templating pass has it.
- **New on-disk files.** `examples/steps/check-merge.yaml`. The
  `examples/sdd.md` doc is updated to teach the fifth node.
- **Tests.** Unit tests for the executor: clean fast-forward
  passes; clean merge-commit auto-merge passes under
  `any-merge`; clean merge-commit auto-merge fails under
  `fast-forward`; conflicting merge fails; the worktree is
  unmodified after every case (HEAD, index, untracked set,
  `MERGE_HEAD` absence are all asserted); a missing `base`
  branch fails with a clear message; an unknown `mode` value
  is rejected as `with:` validation. Step-loader test that
  `examples/steps/check-merge.yaml` parses cleanly. Factory
  integration test that loads the updated `examples/sdd.yaml`
  and asserts the new topology, node count, terminal node, and
  executor mix. A fixture factory test that wires
  `check-merge` into a graph with an `on_failure` edge to
  cover the composability path (the SDD factory does not
  itself declare such an edge in v0). Templating tests for the
  new `{{ run.base_branch }}` token (resolves to the base
  branch, leaves verbatim when out of scope, becomes empty
  string when the run has no base branch).
- **Documentation.** `docs/concepts/Factory.md` and
  `docs/concepts/Step.md` gain a mention of `check-merge` as a
  bundled built-in. `examples/sdd.md` teaches the new node and
  its placement. `docs/Open-Questions.md` is updated to note
  that the cycle-on-conflict edge story now has a prerequisite
  satisfied (the probe exists), but the open question itself
  remains gated on node-outputs.
- **Out of scope** (deferred to follow-on changes or open
  questions): performing the merge (lives in the runner per
  [[autorun-auto-merge]]); emitting structured conflict context
  as node outputs; cycle-on-conflict edge semantics;
  auto-discovering the base from git config (overrides go
  through `with:`); cross-repo / multi-base probes.
