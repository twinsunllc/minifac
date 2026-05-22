## Context

The runner currently knows exactly one executor type: `claude`
(`src/executor/claude.ts`, registered in `defaultRegistry()` at
`src/cli.ts:66`). The executor registry (`src/executor/registry.ts`)
is the extension seam; adding a new executor type is a matter of
implementing the `NodeExecutor` interface (`src/executor/types.ts`)
and registering it before runs start.

Steps that ship in the package follow the bundling rules from
ADR 0030 (`docs/decisions/0030-Bundle-Builtins.md`): the YAML lives
under `examples/steps/` in the source tree, `package.json#files`
includes `examples/`, and `minifac:<name>` references resolve via
the installed package root first, then the source-tree fallback.
Adding a new built-in step is "drop a YAML file in
`examples/steps/`"; the resolver picks it up.

Brief + run substitution lives in `src/factory/templating.ts` (the
`applyBriefAndRunTokens` family). The `run` namespace today
includes at least `cwd`. The runner threads run-scope values
through to the templating pass via `RunOptions` /
`src/runner/run.ts`. Adding a new `run.*` field is "thread the
value, add it to the token table, write tests."

The autorun work has already bound the operator-facing merge action
to the runner (`runMerge` in `src/cli/merge.ts`); auto-merge is
filed as a successor brief (`inputs/autorun-auto-merge.md`) that
`depends_on: [check-merge-step]`. This change is the read-only
probe — strictly separable from the action — and stands alone.

## Goals / Non-Goals

**Goals**

- A factory-author-facing built-in step that answers "would this
  branch merge cleanly onto its base right now?" without
  performing the merge.
- A deterministic, side-effect-free probe. The worktree's `HEAD`,
  index, working tree, and untracked file set SHALL be byte-for-
  byte identical before and after the step runs.
- A new executor type registered by default, so a factory author
  only needs to write `uses: minifac:check-merge`; no manual
  registry plumbing.
- A `run.base_branch` substitution token so factories can probe
  against the same base their worktree was created from without
  hand-wiring branch names in YAML.
- Adoption in the shipped SDD factory, as a dogfooding signal and
  to make the autorun-auto-merge flow more likely to succeed
  (the probe just passed, so the merge is very likely to succeed
  too).
- v0 returns success/failure only via the standard
  `MINIFAC_STATUS` / `status: succeeded|failed` event surface.
  No structured conflict output.

**Non-Goals (v0)**

- Performing the merge. Filed in [[autorun-auto-merge]]; this
  change is read-only.
- Emitting structured conflict context (file list, hunks, base
  SHA) as node outputs that downstream nodes can read. Filed in
  `docs/Open-Questions.md` under the cycle-on-conflict edge
  story; depends on the node-outputs surface
  ([[0027-Node-Outputs]] et al.) maturing.
- Cycle-on-conflict edge semantics (an `on_merge_conflict` edge
  that routes back to `apply`). Same dependency as above.
- Auto-discovering the base branch from `git config`,
  `origin/HEAD`, or the most recent merge base. The base is the
  run's configured base; overrides go through `with: { base: ... }`.
- Cross-repo / multi-branch probes. Single worktree, single base,
  single probe.
- A shell-style generic executor (filed as a separate "phase 4"
  effort per ADR 0018's design notes); the `check-merge`
  executor is purpose-built and validates a narrow `with:`
  schema.

## Decisions

### Decision: New built-in executor, not a new shell-style runner

A check-merge probe is a deterministic git operation. It could in
principle be a `shell` step that runs `git merge-tree ...` and
inspects exit / output. We reject that for v0:

- The generic shell executor isn't in v0 yet (per the
  reusable-steps design notes); landing it on this change would
  bundle two scope items.
- A purpose-built executor can validate its `with:` cleanly
  (`base` is a string, `mode` is one of two literals) and emit a
  clear event stream without users having to author the git
  invocation themselves. The contract is narrow and the
  implementation is small.
- A purpose-built executor can also enforce the worktree-clean
  invariant programmatically (re-check HEAD / index / `MERGE_HEAD`
  absence after the probe); a shell-step path would push that
  burden on the script author.

When the generic shell executor lands, a contributor MAY refactor
the `check-merge` step to use it (the step file's `executor:`
field would swap), but the bundled step file's input contract
stays stable, so user factories keep working.

**Rejected alternative.** Land a `shell` executor first and write
the check-merge probe as a shell step. Doubles scope; pushes the
invariant-enforcement burden into a YAML body.

### Decision: `git merge-tree` is the primary plumbing, with a `git merge --no-commit --no-ff` + `git merge --abort` fallback

`git merge-tree` (the modern, post-2.38 variant that takes
`--write-tree` and reports conflicts via exit code) is read-only
by construction: it writes a tree object to the object database
but touches nothing in the working tree or the index. That's
exactly the invariant we want.

For environments where `git merge-tree` isn't available or doesn't
behave the way we expect, the fallback is to start a `git merge
--no-commit --no-ff <base>`, observe whether it produced conflicts
(via exit code or `MERGE_HEAD` presence), and then unconditionally
`git merge --abort`. The fallback is slightly more brittle (an
interrupted process could leave `MERGE_HEAD` behind), but in
practice the executor runs to completion within milliseconds and
handles the abort in a `finally` block.

The executor SHALL try `git merge-tree --write-tree --name-only
<base> <head>` first. If that command exits 128 (unrecognized
flag, old git) the executor SHALL fall back to the merge-abort
path. Both paths SHALL preserve the worktree-clean invariant.

**Rejected alternative.** Use only `git merge --no-commit --no-ff`
+ `git merge --abort`. Works but is less robust on partial-failure
boundaries; merge-tree is the right primary tool when available.

### Decision: `mode: "fast-forward" | "any-merge"`, default `any-merge`

The brief asks for two modes. `any-merge` (default) is the lenient
contract: the probe passes whenever the merge would auto-resolve
cleanly, whether via fast-forward or via a merge commit.
`fast-forward` is stricter: the probe passes only when `HEAD`'s
ancestry includes the base (or is reachable by linear advance from
it), and fails otherwise — even when an auto-merge with a merge
commit would have succeeded.

Detection: `fast-forward` is equivalent to `git merge-base --is-
ancestor <base> <head>` exiting 0 (the base is an ancestor of
HEAD, so a fast-forward merge would just advance the base). Under
`mode: "fast-forward"`, the executor SHALL run that ancestor check
*before* the merge-tree probe; if the ancestor check fails, the
step fails even if the merge would otherwise auto-merge cleanly.

**Rejected alternative.** Only ship `any-merge`. Drops a
meaningful configurability axis for factories that want to
enforce linear history. Cheap to add now.

**Rejected alternative.** Add a `mode: "rebase"` that probes
whether HEAD's commits rebase cleanly onto base. Useful but
substantially more code (rebase has more failure modes than
merge), and the brief explicitly names only the two modes above.
Defer to a follow-on.

### Decision: `base` defaults to `{{ run.base_branch }}`

A factory author shouldn't have to hand-wire the base branch into
the step's `with:` when the run already knows what base the
worktree was created from. The step file declares
`base: { type: "string", default: "{{ run.base_branch }}" }`; at
load time the default is substituted into the step's `with:`
verbatim (per the reusable-steps templating rules — brief / run
tokens in default values survive into the inlined body); at
dispatch time the runner's templating pass resolves the
`{{ run.base_branch }}` token to the actual base.

This requires adding `base_branch` to the `run`-scope token table.
The value comes from `RunOptions.baseBranch` (or whatever field
name the implementer picks); the in-place / non-worktree run case
SHALL resolve to the empty string, and the check-merge executor
SHALL fail validation with a clear message when its resolved
`base` is empty — "the run was not started from a base branch;
declare `with: { base: <branch> }` explicitly".

**Rejected alternative.** Default `base` to the literal string
`main`. Wrong on most repos. Forces factory authors to override
every time.

**Rejected alternative.** Default `base` to whatever
`origin/HEAD` resolves to. Requires a `git` invocation at load
time, adds a network-or-fetch dependency surface, and is wrong
when the run was deliberately started from a non-default base.

### Decision: `check-merge` is terminal in SDD; failure ends the run as failed

The shipped SDD factory places `check-merge` after `archive` and
marks it terminal. There is no `on_failure` edge out of it in v0.
A conflict means:

- The run record persists as `failed` (with a reason naming
  `check-merge`).
- The brief stays at `inputs/<change>.md` (it never moves to
  `inputs/done/`).
- The operator inspects the worktree, resolves the divergence
  (rebase / cherry-pick / manual edit), and re-runs the change.
- When the autorun auto-merge work lands ([[autorun-auto-merge]]),
  the merge will be very likely to succeed in the autorun success
  path because this probe just passed.

We deliberately do not route `check-merge` failure back to
`apply`. The model has no reliable signal in v0 about *what*
conflicted — that's exactly the structured-conflict-output
problem filed under [[Open-Questions]]. Routing back to `apply`
without that context would burn cycles guessing. The cycle-on-
conflict edge story is unblocked by this change (the probe
exists) but still gated on node-outputs.

**Rejected alternative.** Place `check-merge` *before* `apply`,
not after `archive`. Useful for fast-fail, but the SDD factory
already invests a successful `verify` before reaching `archive`;
the most likely point of divergence is between `propose` and
`archive`. The post-archive placement maximizes the value of the
probe per run-cost. Factory authors who want both placements can
add a second `check-merge` node — the step is read-only and
re-entrant.

**Rejected alternative.** Make `check-merge` non-terminal and
route to `archive` again on success, creating a wait-and-retry
loop. Unnecessary — if the probe passes once, it would pass again
moments later. Adds complexity for no gain.

### Decision: Worktree-clean invariant is a binding contract, not a best-effort

The executor SHALL produce no detectable change to the worktree —
not just "no committed change". Specifically: `HEAD` remains the
same commit, the index (`git status --porcelain`) is identical,
no `.git/MERGE_HEAD` / `.git/MERGE_MSG` / `.git/MERGE_MODE` /
`.git/AUTO_MERGE` files exist after the probe that did not exist
before, and the untracked file set is unchanged. A test SHALL
snapshot these before and assert equality after, in every
scenario (clean, fast-forward, conflicting).

This binds the executor's implementation toward the merge-tree
path (which is read-only by construction) and away from the
merge-abort path as a default, but the fallback is still allowed
provided the cleanup is guaranteed. The cleanup SHALL run in a
`finally` block; the executor SHALL NOT propagate a failure to
the runner without first attempting cleanup.

### Decision: Step lives in the SDD-factory capability for adoption, but the executor and step file shape live in the new `check-merge-step` capability

The new behavior (executor, step file, defaults, semantics) belongs
in its own capability — `check-merge-step` — so the contract is
discoverable and not lost in `sdd-factory`. The SDD-factory
capability is *modified* to adopt the new node; the *definition*
of the node lives elsewhere.

This keeps the dependency direction clean: a user factory that
adopts `minifac:check-merge` reads `check-merge-step`'s spec to
understand the contract; the SDD factory's spec covers only "the
shipped SDD factory adopts the step at position N".

## Risks / Trade-offs

- **Risk: `git merge-tree` behavior varies across git versions.**
  The modern `--write-tree` variant is in git 2.38+ (Oct 2022).
  Users on older gits will hit the fallback path. → Mitigation:
  the executor SHALL detect the fallback case (exit 128 / unknown
  flag) and switch paths transparently. Both paths share the
  worktree-clean invariant tests.
- **Risk: The fallback path (`git merge --no-commit --no-ff` +
  `git merge --abort`) can leave artifacts if the process dies
  between the merge and the abort.** → Mitigation: the executor
  SHALL run the abort in a `finally` block. The unit tests SHALL
  exercise the abort path explicitly. The risk of an in-process
  death between two synchronous awaits is acceptable for v0.
- **Risk: `mode: "fast-forward"` users expect the step to gate
  *post-merge* linearity, not pre-merge mergeability.** →
  Mitigation: the spec is explicit — `fast-forward` means "the
  merge would be a fast-forward; merge commits are disallowed".
  Docs / step description say so.
- **Risk: Adding `{{ run.base_branch }}` is a templating-grammar
  change that callers could come to depend on without realizing
  the empty-string-fallback case.** → Mitigation: the templating
  spec delta documents the empty-string case; the check-merge
  executor's `with:` validation surfaces a clear error pointing
  at the missing base. The unit tests cover the in-place /
  no-base case.
- **Risk: The SDD factory adoption could mask the value of
  composability** (readers see check-merge only in the
  post-archive slot and don't realize it's drop-anywhere). →
  Mitigation: docs in `examples/sdd.md` and `docs/concepts/
  Factory.md` explicitly say "this step is read-only and
  composable; drop it anywhere".
- **Trade-off: The probe duplicates work that the autorun
  auto-merge step would otherwise do at the end.** Yes — that's
  by design. The probe is the cheap, factory-controlled signal
  that the merge will succeed; the runner's actual merge is the
  authoritative action. Running both in sequence is the expected
  composition.
- **Trade-off: A `terminal` `check-merge` in SDD means a failing
  probe ends the run as `failed`, not as `succeeded-but-unmerged`.**
  This is intentional — the brief stays at `inputs/<change>.md`
  precisely because the work isn't actually done until the
  branch can merge. The autorun-auto-merge flow's
  `succeeded-but-unmerged` state is a separate signal that
  arrives only after this probe has passed.

## Migration Plan

1. Land the executor + step file behind no flag. Existing
   factories continue to work unchanged; the new behavior is opt-
   in via `uses: minifac:check-merge`.
2. Land the `{{ run.base_branch }}` token. Existing templates that
   don't use it are unaffected (out-of-scope tokens pass
   verbatim, which means an unrelated factory that happens to
   contain `{{ run.base_branch }}` would now substitute it — but
   such a factory is implausible because the token didn't
   resolve before).
3. Update `examples/sdd.yaml` to add the fifth node, flip
   `archive.terminal` off, add the `archive → check-merge` edge.
   Update the structural test and the regression snapshot in
   lockstep.
4. Verify by running the migrated SDD factory against an
   OpenSpec-equipped scratch repo. Confirm: a clean run ends with
   `check-merge` succeeding and the brief moving to
   `inputs/done/` (under autorun) or staying put (under
   `minifac run`).
5. No rollback step needed — the change is additive. Reverting
   the SDD adoption is a single commit; reverting the subsystem
   is reverting `src/executor/check-merge.ts` and the spec deltas.

## Open Questions

- Should the executor probe accept a `with: { base_ref: <sha> }`
  override alongside the branch name, so factories can probe
  against a specific commit? Defer — the brief explicitly says
  branch-only, and a SHA would require additional validation.
- Should `mode: "fast-forward"` accept "fast-forward or
  already-up-to-date" (which it does today as a side effect of
  `--is-ancestor`) versus strictly "fast-forward, not already
  up-to-date"? The lenient interpretation is the natural one;
  document it in the step's `description`.
- When the structured-conflict-output story lands (per
  [[Open-Questions]]), this executor's failure event SHALL grow
  a `meta` payload naming the conflicting files. v0's `status:
  failed` event carries no payload beyond a human-readable
  message. The shape of the future payload is not designed here.
- Whether `examples/steps/check-merge.yaml` should declare its
  inputs as `required: false, default: "{{ run.base_branch }}"`
  (the chosen path) or `required: true` with no default (forcing
  every adopting factory to map the brief / run explicitly).
  Chose the defaulted path because the substitution gives factory
  authors the right behavior with zero per-node config; the
  override stays available via `with: { base: ... }`.
