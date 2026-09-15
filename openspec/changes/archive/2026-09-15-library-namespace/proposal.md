## Why

A factory repository (scarif-spec `factory-repo-contract`) runs a
shared workflow from a pinned **library** repository with its own
overrides on top: library at the pin, then the factory's `workflows/`
and `steps/`, then the node, with whole-artifact replacement. The
contract rules that the graph runner does that resolving (issue #44).

minifac cannot. `uses:` resolves only from `.minifac/steps/` and
built-ins; workflows only from `.minifac/factories/`; `extends:`
takes a bare name or `minifac:<name>` and rejects paths, so a
factory's `standard_implementation` cannot extend the library's
`standard_implementation` (a bare `extends:` of the same name is the
file itself). Nothing fetches a remote — the cached-remote and
fetch-fresh resolver layers in `docs/concepts/Reference.md` were
never built. The first consumer, `twinsunllc/scarif-factory`, carries
a full copy of the library workflow and a `bin/workspace` script that
clones the library and copies files into `.minifac/` (FINDINGS F1).

## What Changes

- **NEW** capability `library-resolution`: a project declares one
  `library: { repo, ref }` in `factory.yaml` or `.minifac/config.yaml`;
  the ref must be a tag or a full sha (branch, abbreviated sha, and
  revision expressions refused); the library is mirrored and each
  resolved sha materialized once under `$MINIFAC_HOME/cache/library/`;
  a warm cache works offline, a cold cache with no network fails
  naming the ref, a stale pin fails naming the ref and the library's
  current head; a tag resolves to its sha once and a moved tag is
  refused.
- **NEW** factory-repo layout: a project with `factory.yaml` gets its
  root `steps/` and `workflows/` as the local layer, after
  `.minifac/`.
- **MODIFIED** `step-schema` "Step reference syntax and lookup
  precedence": new `library:<name>` form (local layer, then library);
  bare names gain the library layer between local and built-in.
  **Pre-existing drift left alone:** this requirement's scenarios say a
  bare name never consults the install root, but `resolveStepRef` has
  consulted it since `bundle-builtins`. openspec refuses to drop a
  scenario from a MODIFIED block, so correcting that is its own change;
  this one does not touch the built-in fallback.
- **MODIFIED** `factory-schema` "Factory `extends:` top-level field"
  and "`extends:` chain resolution rules": new `library:<name>` form
  (library only); bare names gain the factory repo's `workflows/` and
  the library's `workflows/`.
- **MODIFIED** `run-cli` "`minifac run` command": factory-by-name
  lookup gains the factory repo's `workflows/` and the library's
  `workflows/` between `.minifac/factories/` and `examples/`; a bad pin
  is reported as a pin error, not a missing factory.
- **NEW** `runs.db` schema v5: `runs.library_repo`, `library_ref`,
  `library_sha`; `LoadedFactory.library` carries the resolved pin and
  the runner records it, so "which workflow ran" is answerable.
- **NEW** ADR `docs/decisions/0039-Library-Namespace.md`.
- No new dependency: git is driven through `child_process`.

## Impact

- New `src/library/library.ts` (+ tests against local bare repos).
- `src/step/resolve.ts`, `src/step/inline.ts`, `src/factory/extends.ts`,
  `src/factory/loader.ts`, `src/cli/resolve.ts`, `src/runner/run.ts`,
  `src/storage/*`, `src/cli/runs.ts`.
- Behaviour is unchanged for a project with no `library:` declaration
  and no `factory.yaml`, except that an `extends:` / `uses:` path-like
  rejection message now lists `library:<name>` among the valid forms.
- `runs.db` v5 is a one-way door: an older binary refuses a v5
  database (same contract as v4).
- Unblocks scarif-factory replacing its copy with
  `extends: library:standard_implementation` and deleting
  `bin/workspace`.
