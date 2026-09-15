## Context

The binding decisions — surface, resolution order per reference form,
the pin rule, the cache, recording — are in ADR 0039
(`docs/decisions/0039-Library-Namespace.md`). This note records how
they land in the code and the choices the code forced.

Current state on `main` (4977ab4): `resolveStepRef(ref, callerCwd)`
walks `.minifac/steps/` → install-root built-in → source-tree
built-in; `resolveExtendsRef` handles `minifac:` and bare names with
fixed candidate lists; `resolveFactoryByName` tries
`.minifac/factories/` then `examples/`. None of them knows about a
project beyond `callerCwd`.

## Goals / Non-Goals

**Goals:** the contract's resolution order with whole-artifact
override; immutable pins that fail loudly; offline tolerance on a warm
cache; the resolved sha on the run row; zero change for projects that
declare no library.

**Non-Goals:** per-reference remote pins (`<scope>/<name>` stays
reserved); more than one library per project; the contract's optional
freshness policy (max pin age, min version); cache pruning; listing
library steps in `minifac steps`.

## Decisions

### One `ProjectLayout`, computed once per load

`loadProjectLayout(projectRoot)` returns `{ library?, factoryRepo }`:
the fetched-and-verified library (repo, ref, sha, tree root) and
whether `factory.yaml` exists. `loadFactory` computes it first — so a
bad pin fails before any artifact resolves — and threads it to
`resolveExtendsChain` and `inlineStepIntoNode` → `resolveStepRef`.
Every resolver takes it as an optional trailing parameter defaulting
to `{ factoryRepo: false }`, so existing callers and tests are
untouched. `resolveFactoryByName` computes it itself for bare names;
the per-process memo in `resolveLibrary` means one `minifac run`
fetches once even though it resolves the name and then loads.

Alternative rejected: a global "current project" singleton — hidden
state, and the loader already takes `callerCwd` explicitly.

### git through `child_process`, no library

The cache is a bare mirror driven with `git clone --bare`, `git fetch
--prune` (explicit `+refs/heads/*` and `+refs/tags/*` refspecs),
`rev-parse`, `for-each-ref --contains` (reachability for a sha pin),
`ls-remote --symref` (the default-branch head for a stale-pin
message), and `read-tree` + `checkout-index` with a throwaway
`GIT_INDEX_FILE` and `--work-tree` pointed at a temporary directory to
materialize a tree without touching the mirror. No new dependency
(3-day cooldown gate); git is already a hard requirement (worktrees).

### Branch and abbreviated-sha detection happen after the fetch

A name alone cannot be classified: a tag may be called `c8d531c`, a
branch `v1.0`. So parse time refuses only what can never be a tag
name (`HEAD`, `refs/…`, revision expressions, a leading `-`), and the
tag → branch → abbreviated-sha checks run against the refreshed
mirror. Tags win.

### Tag first-resolution record

`<cache>/<key>/tags.json` maps tag → first sha. Written only on first
resolution. This is what makes "a tag resolves to its sha once"
enforceable: the fetch force-updates tags (`+refs/tags/*`), so without
the record a moved tag would be followed silently.

### `library:` on steps consults local; on `extends:` it does not

See ADR 0039. In code: `resolveStepRef` builds
`[...local, ...library]` for `library:`, `[...local, ...library,
...builtin]` for bare; `extendsCandidates` returns only the library
path for `library:`.

### Recording

`LoadedFactory.library?: { repo, ref, sha }`; `runFactory` passes it
to `store.createRun`; migration 0005 adds three nullable columns.
Three columns rather than one JSON blob so the pin is queryable
(`WHERE library_sha = ?`).

## Risks / Trade-offs

- **Every load contacts the remote.** Needed for stale detection;
  tolerated offline with a warning. A long-running `autorun`/`serve`
  resolves each pin once per process.
- **A bad pin fails every factory in the project**, library-using or
  not. Intended (fail closed), and it is what the contract asks of
  preflight.
- **Unbounded cache growth.** One tree per sha. Future `refs prune`.
- **Library content is trusted.** The library is code the project
  chose to pin; symlinks in its tree are materialized as symlinks.
  Same trust level as the factory files themselves.
