## Why

The bundled SDD factory and its `minifac:openspec-*` steps don't ship with
the npm-installed package today, so the README's quickstart
(`npx minifac init --with-sdd && npx minifac run …`) is currently
aspirational. Two compounding issues block the OSS launch:

1. `package.json#files` excludes `examples/`, so the tarball ships only
   `dist`, `README.md`, `LICENSE`, and `CHANGELOG.md`.
2. The reference resolver (`src/step/resolve.ts`, `src/factory/extends.ts`,
   `src/cli/resolve.ts`) hardcodes `callerCwd`. Even if `examples/` shipped
   in the tarball, `minifac:<name>` references wouldn't look in
   `node_modules/minifac/examples/`.

This change makes the bundled built-ins actually available to installed
users while preserving the source-tree dogfood workflow. It also locks in
the loud-rejection treatment for the `<scope>/<name>` form (reserved for
future remote resolution) so we don't accidentally encode silent fall-
through behavior. See `docs/decisions/0030-Bundle-Builtins.md` for the
binding decision and [[Reference]] for the broader resolver direction.

## What Changes

- **Tarball:** add `examples` to `package.json#files` so
  `examples/sdd.yaml`, `examples/hello.yaml`, every
  `examples/steps/openspec-*.yaml`, plus `examples/sdd.md` and
  `examples/sample-brief.md` ship in the published package.
- **Install-root utility:** add a small `installRoot()` helper that
  resolves the installed package's directory (the directory containing
  `package.json`) from `import.meta.url`, cached for the process.
- **Step resolver:** when a step reference uses the `minifac:<name>`
  prefix, `resolveStepRef` SHALL look up
  `<install-root>/examples/steps/<name>.yaml` first, then fall back to
  `<callerCwd>/examples/steps/<name>.yaml`. The error message on a miss
  names both paths tried.
- **Factory `extends:` resolver:** `resolveExtendsRef` mirrors the same
  two-step lookup for `extends: minifac:<name>` references.
- **Factory-by-name resolver:** `resolveFactoryByName` mirrors the same
  two-step lookup for `--factory minifac:<name>` and for a brief's
  `factory: minifac:<name>` field.
- **Scoped form rejected at resolution:** `<scope>/<name>` references
  (both step `uses:` and factory `extends:`, where applicable) parse but
  SHALL throw a clear "not yet supported — see Reference.md" error at
  resolution time. Today the form silently falls through to a bare-name-
  shaped lookup that almost always fails with a confusing message; loud
  rejection is the contract for future remote resolution.
- **`minifac steps` discoverability:** the existing `--source built-in`
  filter SHALL surface bundled steps from the installed package
  directory in addition to (or instead of) `<cwd>/examples/steps/`. No
  new flag.
- **Smoke test:** add a gated integration test that packs the project,
  installs it into a clean tmp directory, runs
  `minifac init --with-sdd`, writes a minimal brief, and asserts the
  factory + step refs resolve cleanly (no token spend; use a mock
  executor or dry-run).
- **Docs:** update `step-schema` / `factory-schema` Purpose blurbs are
  out of scope; their resolution requirements are updated here. The
  `[[Step]]`, `[[Factory]]`, and `[[Reference]]` concept docs note that
  `minifac:*` resolves against the installed package, and the README
  quickstart is verified to actually work.

Out of scope: remote resolution (`github.com/<org>/<repo>@<ref>`),
marketplace/discovery, compiling YAMLs into JS, an installed-package
lookup for **bare** (`<name>`) references (those stay user-local-only),
versioned built-ins, and `minifac refs pin` / `refresh` commands.

## Capabilities

### New Capabilities

(none — this change tightens existing resolver semantics rather than
introducing a new capability surface)

### Modified Capabilities

- `step-schema`: the `minifac:<name>` lookup gains an installed-package-
  first path; the `<scope>/<name>` form is rejected at resolution with a
  clear error.
- `factory-schema`: the `extends: minifac:<name>` lookup gains the same
  installed-package-first path; the `<scope>/<name>` form has never been
  accepted here and remains rejected, but the spec scenarios document
  the install-root precedence.
- `run-cli`: factory-by-name resolution for `minifac:<name>` (used by
  `--factory`, brief `factory:`, and `minifac run <thing>` fall-through
  to factory-by-name) gains the installed-package-first path; the
  `minifac steps --source built-in` filter surfaces bundled steps from
  the installed package directory.

## Impact

- **Code:** `package.json`, `src/packaging/install-root.ts` (new),
  `src/step/resolve.ts`, `src/factory/extends.ts`, `src/cli/resolve.ts`,
  `src/cli/steps.ts` (or equivalent), and the corresponding test
  modules.
- **Tarball:** grows by `examples/` (well under 100 KB).
- **Dogfooding:** running from the source tree continues to work — the
  install root and `callerCwd` collapse to the same path in that case.
- **Docs:** `docs/concepts/Step.md`, `docs/concepts/Factory.md`,
  `docs/concepts/Reference.md`, `docs/README.md` (Reading Order),
  `docs/CLI.md`, `README.md` quickstart sanity-check.
- **No new dependencies.** No runtime behavior change for users running
  from a source tree.
