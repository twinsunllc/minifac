## 1. Tarball contents

- [x] 1.1 Add `examples` to `package.json#files`
- [x] 1.2 Run `npm pack --dry-run` and confirm the tarball lists
  `examples/sdd.yaml`, `examples/hello.yaml`, every
  `examples/steps/openspec-*.yaml`, `examples/sdd.md`, and
  `examples/sample-brief.md`

## 2. Install-root utility

- [x] 2.1 Create `src/packaging/install-root.ts` exporting a cached
  `installRoot()` that resolves the package directory from
  `import.meta.url` (`<pkg-root>/dist/packaging/install-root.js` →
  `../..`)
- [x] 2.2 Add a unit test that reads `package.json` from the
  returned path and asserts `name === "minifac"`
- [x] 2.3 Add a unit test that verifies the cached result is
  returned on subsequent calls (no repeated `fileURLToPath` cost)

## 3. Step resolver: `minifac:<name>` install-root lookup

- [x] 3.1 Update `resolveStepRef` in `src/step/resolve.ts` to try
  `<install-root>/examples/steps/<name>.yaml` first, then fall back
  to `<callerCwd>/examples/steps/<name>.yaml`
- [x] 3.2 Update the `StepLoadError` "Could not resolve" message to
  name both paths in order
- [x] 3.3 Add unit tests for: install-root hit, source-tree
  fallback hit, neither path exists (error names both), local file
  present but ignored under `minifac:`

## 4. Step resolver: reject `<scope>/<name>` at resolution

- [x] 4.1 In `resolveStepRef`, when `parsed.scope` is set and not
  `builtinForced`, throw `StepLoadError` whose message identifies
  the reference, calls the scoped form reserved-for-future, and
  points at `docs/concepts/Reference.md`
- [x] 4.2 Add unit tests for: `myorg/foo` rejected with the
  documented error, `myorg/foo@1.0.0` rejected with the pin
  preserved in the error message
- [x] 4.3 Confirm existing `parseStepRef` tests for the scoped form
  still pass (parse succeeds; resolution rejects)

## 5. Factory `extends:` resolver

- [x] 5.1 Update `resolveExtendsRef` in `src/factory/extends.ts` to
  try `<install-root>/examples/<name>.yaml` first, then fall back
  to `<callerCwd>/examples/<name>.yaml`
- [x] 5.2 Update the `walkExtendsChain` pre-existence check so the
  thrown `FactoryLoadError` message names both candidate paths in
  order for `minifac:<name>` references
- [x] 5.3 Confirm bare-name `extends:` lookups still resolve only
  against `<callerCwd>/.minifac/factories/<name>.yaml` (install
  root NOT consulted)
- [x] 5.4 Add unit tests for: `extends: minifac:sdd` install-root
  hit, source-tree fallback hit, neither path exists (error names
  both), bare `extends: sdd` still works and does not consult the
  install root

## 6. Factory-by-name resolver (`--factory`, brief `factory:`)

- [x] 6.1 Update `resolveFactoryByName` in `src/cli/resolve.ts` so
  that `minifac:<name>` tries `<install-root>/examples/<name>.yaml`
  first, then `<cwd>/examples/<name>.yaml`
- [x] 6.2 Update the `RunArgResolutionError` message for the
  `minifac:` form to name both paths in order
- [x] 6.3 Confirm bare-name resolution still tries
  `.minifac/factories/<name>.yaml` then `<cwd>/examples/<name>.yaml`
  (install root NOT consulted)
- [x] 6.4 Add unit tests for: brief `factory: minifac:sdd` install
  hit, source-tree fallback, install-root miss error message,
  `--factory minifac:sdd` parity, bare `factory: sdd` install root
  ignored

## 7. `minifac steps --source built-in` reads the install root

- [x] 7.1 In the steps subcommand implementation, switch the
  built-in scan from `<cwd>/examples/steps/` to
  `<install-root>/examples/steps/`, falling back to
  `<cwd>/examples/steps/` when the install-root path does not exist
- [x] 7.2 Confirm the `--json` `path` field reports the absolute
  path that was actually scanned (install-root path when present)
- [x] 7.3 Add a CLI test exercising the install-root and source-
  tree-fallback paths

## 8. Smoke test: clean tmp install

- [x] 8.1 Add a gated integration test (env-var-gated, e.g.
  `MINIFAC_SMOKE_TEST=1`, so it does not run by default) that:
  packs the project (`npm pack`), creates a fresh `/tmp/<random>`
  directory, runs `npm init -y` + `npm install <tarball>`, invokes
  `npx minifac init --with-sdd`, writes a minimal brief at
  `inputs/smoke-test.md`, and asserts the factory + step refs
  resolve cleanly (no Claude dispatch — mock executor or
  `--dry-run` equivalent)
- [x] 8.2 Document in the test file how to opt in
  (`MINIFAC_SMOKE_TEST=1 npm test`) and approximate runtime

## 9. Documentation

- [x] 9.1 Update `docs/concepts/Step.md` to note that
  `minifac:<name>` references resolve against the installed
  package's `examples/steps/` first, source-tree second; bare
  names stay user-local
- [x] 9.2 Update `docs/concepts/Factory.md` to note the same for
  `extends: minifac:<name>` and `factory: minifac:<name>`
- [x] 9.3 Update `docs/concepts/Reference.md` (or create the
  cross-link if not already wired) and add it to the Reading
  Order in `docs/README.md`
- [x] 9.4 Verify and update `docs/CLI.md` so the `init --with-sdd`
  wording matches post-fix reality (the quickstart now actually
  produces a runnable factory end-to-end)
- [x] 9.5 Walk the README quickstart against a packed tarball to
  confirm it works; tweak wording only if behavior shifts

## 10. Verification

- [x] 10.1 `npm run build` succeeds
- [x] 10.2 `npm test` passes the full existing test suite
- [x] 10.3 `MINIFAC_SMOKE_TEST=1 npm test` passes the gated smoke
  test
- [x] 10.4 `npm run check` (lint + format) is clean
- [x] 10.5 `openspec validate bundle-builtins` exits `0`
