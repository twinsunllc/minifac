---
change: factory-override-at-invocation
factory: sdd
base_branch: main
depends_on: [run-scoped-branches]
---

## Background

Today the brief's `factory:` field is authoritative. To A/B the
same brief through two factories, you'd have to copy the brief.
[[0020-Factory-Override-At-Invocation]] introduces a `--factory`
flag on `minifac run` that overrides the brief's field at
invocation time, plus a lockfile scope widening so concurrent
A/B runs work. Read 0020 first.

This builds on [[0019-Run-Scoped-Branches]] — the per-run branch
identity is what makes the two attempts distinguishable in git.

## What to do

Implement what 0020 describes. Concretely:

### 1. `--factory` flag on `minifac run`

- Add the flag to the run subcommand in `src/cli.ts` (or wherever
  the run command lives now).
- When provided, the flag value replaces the brief's `factory:`
  field for that invocation. The brief file is not modified.
- Resolution of the flag value goes through the same
  `resolveFactoryByName` path used for the brief's field — local
  `.minifac/factories/<name>.yaml` first, built-in
  `examples/<name>.yaml` second, `minifac:<name>` forces built-in.
- The brief's `factory:` becomes the default; if the flag is
  absent, behavior is unchanged from today.

### 2. Lockfile scope widening

- Lockfile key changes from `(repo-hash, change)` to
  `(repo-hash, change, factory_name)`.
- File path: `~/.minifac/locks/<repo-hash>-<change>-<factory>.lock`.
- Two `minifac run foo` invocations through the same factory still
  serialize (one wins the lock; the other fails clearly).
- Two `minifac run foo` invocations through *different* factories
  proceed concurrently — that's the whole point.
- Stale-lock detection (per existing worktree-mode behavior) still
  applies per-key.

### 3. runs.db usage

- No schema changes — `factory_name` and `factory_path` columns
  are already present.
- The run row records whichever factory was actually used (brief's
  default or the CLI override).
- `minifac runs --change <change>` queries already surface
  `factory_name`; verify the output formatting makes it visually
  obvious when two runs of the same change used different
  factories.

### 4. `minifac autorun` integration

- Add a parallel `--factory` flag to `minifac autorun` that
  applies to every brief autorun schedules. Briefs whose own
  `factory:` field differs from the override are still run
  through the override (consistent with `minifac run`).
- Default behavior (no flag) is unchanged: each brief uses its
  declared factory.

### 5. Tests

- `minifac run foo` (no flag) uses the brief's declared factory
- `minifac run foo --factory bar` uses `bar` and records that in
  runs.db
- `minifac run foo --factory minifac:sdd` skips local lookup,
  goes straight to built-in
- Unknown factory name in `--factory` errors clearly with the
  same shape as today's "factory not found" error from the brief
  field
- Two concurrent `minifac run foo --factory A` and `minifac run
  foo --factory B` succeed in parallel (both worktrees created,
  both runs recorded)
- Two concurrent `minifac run foo --factory A` calls: one wins,
  one is refused at the lockfile
- `minifac autorun --factory X` applies X to every scheduled
  brief
- All existing tests still pass

### 6. Specs

- `run-cli`: MODIFIED requirement for the `run` subcommand to
  add the `--factory` flag and document the lockfile scope
  change. ADDED requirement (if needed) for `autorun --factory`.
- `worktree-management`: MODIFIED requirement for the lockfile
  keying.
- `brief-schema`: MODIFIED requirement to note that `factory:`
  is now the *default* and may be overridden at invocation.
  The field is still required in the brief (always
  self-describing) but is no longer exclusive.

When MODIFYING, copy the entire requirement block; do not
partial-paste.

### 7. Documentation

- Update `docs/concepts/Brief.md` to mention that `factory:` is
  the default and can be overridden.
- Update `docs/concepts/Factory.md` Composition section to
  reference the override path.
- Add a short worked example to `examples/sdd.md` or the README:
  "comparing two factories on the same brief."

## Out of scope

- **Studio UI for factory comparison.** Studio's concern.
- **Automated A/B harness** (run brief through N factories,
  compute diff, recommend a winner). Useful but a separate
  proposal once enough A/B happens to motivate it.
- **Brief-less factory invocations gaining a `--brief` override.**
  Symmetric idea but not in scope here.
- **Cost-aware A/B** (run through cheap-model first, fall back to
  expensive). Out of scope.

## Acceptance criteria

- `minifac run foo --factory bar` produces a run whose
  `factory_name` in runs.db is `bar`, regardless of what the
  brief declared
- Two concurrent `minifac run foo --factory A` and
  `minifac run foo --factory B` produce two distinct runs and
  two distinct branches (per [[0019-Run-Scoped-Branches]])
- Concurrent invocations of the *same* (change, factory) pair
  serialize via the lockfile
- `minifac autorun --factory X` applies the override to every
  scheduled brief
- All existing tests still pass; new tests cover override
  resolution, lockfile widening, and the autorun flag

## Note on ordering

Depends on `run-scoped-branches` landing first — that change
provides the per-run branch identity that distinguishes two A/B
attempts in git. This brief explicitly carries `depends_on:
[run-scoped-branches]` to enforce the order via
[[0015-Brief-Deps-and-State]] (which should also have landed by
the time this runs).
