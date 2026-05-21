## Why

Today a brief's `factory:` field is authoritative: `minifac run foo`
runs `inputs/foo.md` through whatever factory the file declares. To
A/B the same brief through two factories (e.g. comparing models,
iterating on a factory definition, eval/benchmarking) the operator
has to copy the brief, edit one copy's `factory:`, and reconcile the
divergence afterward. This produces noisy commits and obscures the
intent ("same input, two implementations").

`[[0019-Run-Scoped-Branches]]` already gives each run a unique
branch (`run/<change>-<slug>`), so per-run artifacts are already
distinguishable in git and in `runs.db`. The only missing piece is
a CLI affordance to override the brief's `factory:` at invocation
time, plus a lockfile scope widening so two A/B runs can proceed in
parallel.

`[[0020-Factory-Override-At-Invocation]]` captures the decision; this
change implements it.

## What Changes

- **ADD** a `--factory <name>` flag to `minifac run`. When supplied,
  the flag's value replaces the brief's `factory:` for that
  invocation; the brief file is not modified. Resolution of the flag
  value uses the same `resolveFactoryByName` precedence already used
  by the brief's `factory:` field (local
  `.minifac/factories/<name>.yaml` first, built-in
  `examples/<name>.yaml` second, `minifac:<name>` skips local).
- **WIDEN** the per-run lockfile key for brief-driven runs from
  `<repo-hash>-<change>` to `<repo-hash>-<change>-<factory>`. Two
  invocations against the same brief through the same factory still
  serialize; two invocations against the same brief through
  different factories proceed concurrently. (Brief-less factory
  runs already have a per-invocation key that includes the factory
  name and a timestamp; their key shape does not change.)
- **CLARIFY** that the brief's `factory:` field is now the *default*
  for any invocation that does not pass `--factory`; the field
  remains required (the brief is still self-describing) but is no
  longer the sole determinant of which factory a brief runs
  through.
- **PRESERVE** `runs.db` schema as-is: the existing `factory_name`
  and `factory_path` columns already record whichever factory a
  given run actually used. No migration is needed.

## Capabilities

### New Capabilities
<!-- None. Behavior is added by modifying existing capabilities. -->

### Modified Capabilities

- `run-cli`: adds the `--factory <name>` flag to the `minifac run`
  subcommand and documents that it overrides the brief's
  `factory:` for the invocation. Resolution uses the same factory-
  by-name lookup precedence as the brief's field. Also updates the
  documented lockfile key for brief-driven runs in the
  run-sequencing block.
- `worktree-management`: changes the lockfile key for brief-driven
  runs from `<repo-hash>-<change>` to
  `<repo-hash>-<change>-<factory>` so two concurrent A/B
  invocations against the same brief can each claim a distinct
  lock. Brief-less keys (`<repo-hash>-<factory>-<timestamp>`) are
  unchanged.
- `brief-schema`: softens the prose around the `factory:` field to
  describe it as the *default* factory for the brief. The field
  remains required and self-describing; the change is documentation
  only (no schema or validation change).

## Impact

- **Code:** `src/cli.ts` (or wherever the `run` subcommand parser
  lives), the factory resolver call site, and the lockfile key
  derivation in the worktree-management module. No new modules.
- **Tests:** new cases covering override resolution (local first,
  `minifac:` prefix, unknown factory), lockfile widening (two
  factories run in parallel; same factory still serializes), and
  runs.db row content (`factory_name` reflects the override).
- **Docs:** `docs/concepts/Brief.md`, `docs/concepts/Factory.md`,
  and an A/B worked example in `examples/sdd.md` or the README.
- **Data:** runs.db schema unchanged. Existing rows are unaffected.
- **Out of scope** (deferred to a separate proposal, tracked in
  `docs/Open-Questions.md`): a parallel `--factory` flag on
  `minifac autorun`. `autorun` is not yet a landed capability;
  when the `auto-mode` change lands it will inherit the same
  override pattern, but pre-specifying it here would commit a
  surface area that has no implementation yet.
