## Why

Today a brief's `factory: <name>` field resolves only to
`<cwd>/examples/<name>.yaml` in the calling repo. That works for
minifac itself — the canonical factories ship in `examples/` — but it
gives target repos no way to customize a factory (e.g. swap
`npm test` for `bun test` in the SDD `verify` node) without copying
the whole YAML, which then drifts from upstream.

Decision [[0008-File-Per-Factory-Composition]] settled the shape:
target repos declare per-repo customizations in
`.minifac/factories/<name>.yaml` with an `extends:` field that
references a built-in (or another local) factory and overrides only
the nodes that differ. This change ships that mechanism end-to-end:
the resolver lookup precedence, the loader's extends-chain resolution
with replace-at-node-level merge, a `minifac init` bootstrap
subcommand, and the docs that point users at it.

## What Changes

- **Resolver precedence (`run-cli`).** `factory: <name>` resolves
  first against `<cwd>/.minifac/factories/<name>.yaml`, then falls
  back to `<cwd>/examples/<name>.yaml`. The new `factory:
  minifac:<name>` prefix skips the local lookup and goes straight to
  the built-in (`examples/<name>.yaml` in the calling repo for v0,
  until packaging moves them into the tool itself).
- **`extends:` in factory YAML (`factory-schema`).** A factory file
  MAY declare a top-level `extends:` string. Valid refs are
  `minifac:<built-in-name>` (built-in) or `<local-name>` (another
  `.minifac/factories/<local-name>.yaml`, recursive extension
  allowed). The loader resolves the chain depth-first, applying
  derived layers on top of the base with **replace-at-node-level**
  merge semantics: any node id declared in the derived layer fully
  replaces the base's node; `edges:` is replaced wholesale when the
  derived layer declares one, otherwise inherited; `name`,
  `description`, `brief` are inherited and overridden when declared.
- **Loader errors.** Cyclic `extends:` chains, a missing base file,
  and a base ref that fails to resolve all surface as
  `FactoryLoadError` with a clear message naming the offending file.
  Validation (start node, cycle budgets, terminal node,
  `factory.brief` enforcement at the CLI) runs against the resolved
  factory, not any individual layer.
- **`minifac init` subcommand (`run-cli`).** New CLI subcommand that
  creates `inputs/`, `.minifac/`, and `.minifac/factories/` in cwd
  (with a `.gitkeep`/README in the factories dir). Idempotent —
  fills in only missing pieces on re-run. Optional `--with-sdd` flag
  writes a starter `.minifac/factories/sdd.yaml` that
  `extends: "minifac:sdd"` and overrides nothing, as a template the
  user can edit.
- **Docs.** `docs/concepts/Factory.md` gains a worked Composition
  example (a `.minifac/factories/sdd.yaml` that overrides one node).
  `examples/sdd.md` (and/or `README.md`) gets a "Customizing the SDD
  factory for your repo" section pointing at the mechanism. The
  brief authoring docs gain a note that `factory:` can target a
  local custom factory or a `minifac:`-prefixed built-in.

## Capabilities

### New Capabilities

<!-- None — composition extends existing factory-schema + run-cli capabilities. -->

### Modified Capabilities

- `factory-schema`: ADDED requirements for the top-level `extends:`
  field, the resolution rules for `minifac:<name>` vs `<local-name>`
  refs, the replace-at-node-level merge semantics, and the load-time
  errors for missing bases and cyclic chains.
- `run-cli`: MODIFIED `minifac run` factory-by-name resolution to
  reflect the two-step lookup precedence and the `minifac:<name>`
  prefix on the brief's `factory:` field. ADDED a `minifac init`
  subcommand requirement.

The `brief-schema` capability is unchanged — the resolution rules
for the brief's `factory:` field live in `run-cli`, not the brief
schema itself. The `sdd-factory` capability is unchanged for v0;
its canonical form is the built-in.

## Impact

- `src/cli/resolve.ts` gains the two-step factory-by-name lookup and
  recognition of the `minifac:<name>` prefix.
- `src/factory/loader.ts` (or a new sibling like `extends.ts`)
  resolves `extends:` chains into a single in-memory factory before
  validation. The exported `loadFactory` signature is unchanged from
  callers' perspective.
- `src/factory/schema.ts` adds an optional top-level `extends:`
  string to the Zod schema. The loader strips it after resolution
  so downstream code never sees `extends:` on the resolved factory.
- `src/cli.ts` gains a `minifac init` subcommand.
- New file `.minifac/factories/README.md` (or `.gitkeep`) is written
  by `init`; the repository itself does not check in a `.minifac/`
  tree (minifac dogfoods through its `examples/` factories).
- Documentation updates in `docs/concepts/Factory.md`,
  `examples/sdd.md`, and the brief authoring skill (no behavior
  change to brief-authoring itself).
- Tests: composition resolver tests (lookup precedence, prefix
  handling), loader tests for the extends chain (happy path,
  missing base, cyclic chain, replace-at-node semantics,
  edge-array replacement, top-level inheritance), and a `minifac
  init` integration test (creates dirs, idempotent, `--with-sdd`).
- Out of scope: independent factory versioning, multi-repo factory
  registries, deep-merge override semantics, moving built-in
  factories out of `examples/`, persistent run history.
