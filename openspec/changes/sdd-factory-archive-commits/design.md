## Context

`openspec archive <change>` is a file-system mutation: it `mv`s the
change directory from `openspec/changes/<change>/` to
`openspec/changes/archive/<dated>-<change>/`, and it rewrites
`openspec/specs/<capability>/spec.md` to fold in any `## ADDED`,
`## MODIFIED`, or `## REMOVED` blocks from the change's spec deltas.
A successful archive leaves a clean working tree in `cwd` only if
something has staged and committed those changes — and `openspec`
itself does not.

The shipped `archive` node prompt today reads:

> Run `openspec archive <CHANGE_NAME>`. This is the terminal node —
> success here ends the run.

Followed by sentinel-emission instructions. Nothing in that prompt
instructs the model to commit. Because the `claude` executor uses
`bypass_permissions`, the model has the authority to run `git commit`
freely; it simply was not asked to. After a real dogfood run (commit
`fcc3985`), the working tree was left dirty and the user committed the
archive moves manually.

This is a contract bug, not a runner bug. The fix lives in the
prompt; the spec needs to bind it so the prompt cannot regress
silently.

Constraints from `CLAUDE.md`:

- No anthropomorphic metaphors. The node is "the archive node," not
  a "scribe" or "librarian."
- Snake_case YAML keys (no schema change needed here, just noted).
- No new runtime dependencies.
- The `node-executor` canonical spec is load-bearing; do not change
  it. This change is entirely at the factory level.
- No DAG-only assumptions (this change preserves the existing
  topology).

## Goals / Non-Goals

**Goals:**

- After a successful run of the shipped SDD factory, the target
  repo's working tree is clean: the archive moves and spec folds are
  committed.
- The commit message convention used everywhere else in this
  repository (`<Verb>: <change-name>` subject + 2–3 line body +
  `Co-Authored-By:` trailer) extends to archive commits.
- The contract is bound by the canonical `sdd-factory` spec so a
  future prompt rewrite cannot accidentally drop the commit
  instruction and silently regress.

**Non-Goals:**

- Changing the runner, executor, or any other shipped factory
  artifact beyond the archive node prompt, the matching spec
  requirement, the matching docs section, and the matching
  structural test.
- Making any other node (`propose`, `apply`, `verify`) produce
  separate commits, change its commit cadence, or alter what gets
  bundled into its commit.
- Implementing a generic "every write-producing node commits at
  the end" rule. The simpler shape is enough: name the commit
  obligation per-node in the spec, the same way the current spec
  names each node's other obligations.
- Pushing the commit to a remote.
- Verifying the commit's signature, identity, or hook configuration.
- Splitting the archive commit into per-file or per-capability
  commits.

## Decisions

### Decision: Commit happens inside the archive node, not as a separate node

The alternative — a fifth node like `commit-archive` chained
`archive → commit-archive (terminal)` — would be more granular but
also more brittle. `openspec archive` and the commit that captures
its result are conceptually one unit of work; if the archive
succeeds and the commit fails, you do not want the runner to "move
on" without intervention. Keeping both inside one node means a
failed commit yields `MINIFAC_STATUS: failed` and ends the run
loudly, which is exactly what should happen.

Splitting them into separate nodes would also add a third spec
requirement (the new node's contract), a third edge, and a new
question about whether the commit node should retry on hook
failure. None of that earns its weight at v0.

**Alternatives considered:**
- (a) Separate `commit-archive` terminal node — rejected as above.
- (b) Have the runner auto-commit after any node whose `cwd` ends
  dirty — rejected as scope creep and contrary to the project's
  "no premature subsystems" rule.
- (c) Pre-commit hook in the target repo — rejected because the
  factory has no way to install or verify it, and not every target
  repo wants the convention.

### Decision: Commit message convention is mandated by the prompt, documented in the spec

The prompt SHALL instruct the model to use:

- **Subject:** `Archive: <CHANGE_NAME>` (literal `Archive:` prefix
  followed by the change name).
- **Body:** 2–3 lines summarising what spec deltas were folded into
  which canonical specs and which change directory was moved (the
  archive timestamp prefix). The body is short by design — the
  archive directory carries the detail, the body is just enough to
  scan in `git log --oneline -n 5`.
- **Trailer:** `Co-Authored-By: Claude Opus 4.7 (1M context)
  <noreply@anthropic.com>` matching the existing convention used in
  this repo's history.

The spec binds the subject-line convention (`Archive: <name>`)
because that is the part future tooling might want to grep for. The
spec does not bind the exact wording of the body or the trailer —
those are prompt-level implementation. The test asserts the prompt
contains the literal substring `Archive:` so a future prompt
rewrite that drops the convention fails the build.

### Decision: Ordering — archive, then commit, then sentinel

The prompt SHALL instruct the model in this strict order:

1. Run `openspec archive <CHANGE_NAME>`.
2. If step 1 exits 0: run `git add -A && git commit -m "Archive: …"`.
   If step 1 exits non-zero: do not run the commit; jump to step 5
   with `failed`.
3. If step 2 exits 0: continue to step 4.
   If step 2 exits non-zero: jump to step 5 with `failed`.
4. Emit `MINIFAC_STATUS: succeeded`.
5. Emit `MINIFAC_STATUS: failed` followed by `REASON: <one-liner
   naming the failing step>`.

This ordering matters because the alternative — commit first, then
archive — would commit a snapshot of the repo before the archive
moves. The opposite order — sentinel first, commit later — is not
possible (the sentinel must be the final thing in the assistant
message, per the `node-executor` spec).

The prompt SHALL also forbid `git push`. The factory never pushes;
that is a human's call. We do not need to add a separate spec
requirement for "no push" because every node's prompt already lives
under the user-trust-cwd posture and the model is told to commit
only the archive moves, not push them.

### Decision: `git add -A` is fine here

`git add -A` will stage any unrelated dirty files in the target
repo's tree. In the SDD loop, that is acceptable because:

- The archive node runs after `verify` succeeded. `verify` is
  read-only by contract (it runs tests and `openspec validate`); it
  should not leave dirty files.
- `apply` has already committed its work (per `apply`'s existing
  contract). Any unstaged files at archive time should be the
  archive's own output plus, possibly, generated files that `apply`
  forgot — and pulling those into the archive commit is harmless
  enough that it does not justify the added complexity of staging
  by path.
- Restricting the stage to a known path set would tightly couple the
  prompt to the OpenSpec CLI's internal output layout. If a future
  `openspec` release moves a file, the prompt would silently miss
  it. `git add -A` survives that.

If a target repo's pre-commit hook complains about the unrelated
files, the commit fails, the node fails loudly, and the user
intervenes. That is the right failure mode for a v0 factory.

**Alternative considered:** `git add openspec/` — rejected. Narrower
but couples to the OpenSpec layout and would miss spec moves outside
`openspec/` if the CLI ever grows them.

### Decision: Hook failure is a node failure, not a retry

If a pre-commit hook rejects the commit (e.g. a lint rule the
factory's edits broke), the `archive` node SHALL emit
`MINIFAC_STATUS: failed` and end the run. The factory does not have
a recovery edge from `archive` and adding one would expand the
topology in ways out of scope here.

The reasoning: a pre-commit hook failure at archive time means the
archive moves themselves are clean (the working tree contains the
expected diff), but some hook policy disallows the commit shape.
That is a human concern — the user should land manually and
investigate the hook. Looping back through `apply` would not help
(apply is for tasks.md work, not for fixing hook policy).

### Decision: Spec change is MODIFIED, not ADDED

The existing "SDD factory per-node responsibility" requirement
already names archive's contract. The right surgical change is to
modify that bullet to include the commit step, and to add two
scenarios (success path and a failure path) under the same
requirement. Adding a brand-new requirement called e.g. "SDD
archive node commits its output" would split the archive contract
across two requirements, which makes it harder to read and easier
to drift.

### Decision: Test asserts the prompt contains the literal substring `git commit` and `Archive:`

Two assertions in `src/factory/sdd-example.test.ts`:

- `archive` prompt contains `git commit`.
- `archive` prompt contains `Archive:` (with the colon, to nail the
  subject-line convention).

We do not write a synthetic prompt-execution test. The structural
substring check is sufficient to catch the regression class we care
about (a future prompt rewrite that silently drops the commit
instruction). Anything stronger would require a real `claude`
invocation, which is out of scope for unit tests.

## Risks / Trade-offs

- **[Model interprets the prompt loosely and the commit subject does
  not match the `Archive: <name>` convention]** → Mitigation: the
  prompt instructs the exact `-m "Archive: <CHANGE_NAME>"` string,
  and the test asserts `Archive:` is in the prompt itself. If the
  model paraphrases the subject at run time, the worst case is a
  commit with a non-conformant subject — the archive moves are still
  captured, the loop still terminates cleanly, and `git log` reads
  slightly differently than expected. We can tighten the prompt
  further in a follow-up if this becomes a real problem.

- **[Pre-commit hook in the target repo rejects the commit and the
  user is confused]** → Mitigation: the `REASON:` line names the
  failing step (e.g. "git commit rejected by pre-commit hook"). The
  user lands manually and investigates. Documented in
  `examples/sdd.md` under the archive section so it is not a
  surprise.

- **[`git add -A` stages unrelated files the user did not want in
  the archive commit]** → Mitigation: documented in the archive
  section of `examples/sdd.md`. If a target repo cares deeply about
  isolation, the user can copy the factory and tighten the stage to
  `git add openspec/`. We accept this trade-off for the shipped
  template because the alternative couples too tightly to OpenSpec
  internals.

- **[Spec drift between this change's archive contract and the
  scenarios in the existing "Verify failure routes back to apply"
  bullet]** → Mitigation: the MODIFIED requirement retains every
  existing scenario; only archive's bullet text and two scenarios
  are added. The verify-related scenarios are not touched.

- **[Users with old copies of `sdd.yaml` continue to leave archive
  uncommitted]** → Mitigation: a one-paragraph note in
  `examples/sdd.md` (alongside the existing pre-this-change
  migration paragraph) tells them which lines to edit.

## Migration Plan

No data migration. No runtime version bump. The shipped factory's
behavior changes only at the prompt-text level; the YAML schema is
unchanged.

Editing `examples/sdd.yaml`, `examples/sdd.md`, the spec, and the
test is a single PR. The structural test catches accidental
prompt-rewrite drift. The spec change locks the contract.

Users with pre-existing copies of `sdd.yaml` from before this
change find the migration paragraph in `examples/sdd.md` and apply
one edit per copy (rewrite the archive node's prompt to add the
commit step). We publish no script; the edit is small.

## Open Questions

- **Should the commit body be templated more strictly?** Today's
  prompt asks the model for a 2–3 line summary. We could mandate a
  specific structure (e.g. a `Folded:` line listing capability
  names, a `Moved:` line giving the archive directory). Deferred —
  let's see how the freeform body reads in practice before
  prescribing structure.

- **Should the archive commit reference the proposal name in the
  body as a Markdown link, so GitHub renders it?** Deferred. The
  proposal markdown is inside the archived change directory, which
  is now in the same commit. A reader can find it from there.

- **Should there be an `on_failure` edge from `archive` back to
  `apply` to retry hook-rejected commits?** No — that would treat
  hook policy as an `apply` task, which is the wrong mental model.
  Hook policy is the user's concern, not a tasks.md item. Leaving
  archive as a no-recovery terminal node is correct.

- **Future: native `git` executor?** A `git` executor could take a
  structured commit spec rather than asking a model to formulate
  one. That is out of scope for v0 and is properly a `node-executor`
  proposal of its own.
