## 1. Library resolution

- [x] 1.1 `src/library/library.ts`: read the `library:` declaration
      from `factory.yaml` / `.minifac/config.yaml` (both = error;
      unknown keys refused); map `repo` to a git URL
- [x] 1.2 Parse-time pin checks (`HEAD`, `refs/…`, revision
      expressions, leading `-`)
- [x] 1.3 Bare mirror under `$MINIFAC_HOME/cache/library/<key>/`:
      clone on a cold cache (failure fatal, naming the ref); fetch
      `--prune` on a warm one (failure → offline fallback + warning)
- [x] 1.4 Resolve the pin: tag (with first-resolution record and
      moved-tag refusal), full sha (reachability), branch refusal,
      abbreviated-sha refusal, stale-pin error naming the default-branch
      head and latest tag
- [x] 1.5 Materialize each sha once, atomically, without `.git`
- [x] 1.6 Per-process memo; `loadProjectLayout` returns
      `{ library?, factoryRepo }`

## 2. Resolvers

- [x] 2.1 `resolveStepRef`: `library:<name>` form (local → library);
      bare names gain the factory repo's `steps/` and the library
- [x] 2.2 `resolveExtendsRef`: `library:<name>` (library only); bare
      names gain the factory repo's `workflows/` and the library
- [x] 2.3 `loadFactory`: compute the layout first (a `LibraryError`
      becomes a `FactoryLoadError`), thread it, return
      `LoadedFactory.library`
- [x] 2.4 `resolveFactoryByName` / `resolveRunArg`: factory repo's
      `workflows/`, then the library's, before `examples/`; a pin error
      is rethrown as itself

## 3. Recording

- [x] 3.1 Migration 0005 (`runs.library_repo/ref/sha`), inline mirror
- [x] 3.2 `CreateRunInput.library`, `StoredRun.library`; SQLite adapter
- [x] 3.3 `runFactory` records `loaded.library`; `minifac runs --json`
      surfaces it

## 4. Tests (local bare git repo as the remote; no network)

- [x] 4.1 Pin validation: tag, full sha, branch, abbreviated sha,
      parse-time refusals, double declaration, moved tag
- [x] 4.2 Cache: materialized once and content-addressed; warm cache
      offline with warning; cold cache unreachable fails naming the
      ref; stale tag and stale sha fail naming the ref and head/tag
- [x] 4.3 Loader: `extends: library:` of the same name; `uses:
      library:`; factory `steps/` override replaces wholly;
      `.minifac/steps/` override of an explicit `library:` ref; unknown
      library step / workflow names the namespace and pin; `library:`
      without a declaration; branch pin fails the load;
      `.minifac/config.yaml` declaration outside a factory repo
- [x] 4.4 Factory by name: factory repo `workflows/`; ignored without
      `factory.yaml`; library fallback; bad pin surfaces as pin error
- [x] 4.5 Storage: v5 fresh + v4→v5 migration; pin round-trip; runner
      records the pin (and `null` without one)

## 5. Docs

- [x] 5.1 ADR 0039
- [x] 5.2 README section on the namespace and the pin rule
- [x] 5.3 `docs/concepts/Reference.md` current grammar and resolution

## 6. Verify

- [x] 6.1 tsc, `npm run check`, `npm test`,
      `openspec validate --all --strict`
- [x] 6.2 Consumer check: scarif-factory's `standard_implementation`
      as a no-override `extends: library:standard_implementation`
      loads through `loadFactory` at `v0.1.0`
