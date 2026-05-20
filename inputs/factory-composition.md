---
change: factory-composition
factory: sdd
base_branch: main
---

## Background

Today factory references in a brief (`factory: sdd`) resolve to
`examples/<name>.yaml` in the calling repo. That works for minifac
itself, where the canonical factories ship in `examples/`, but it
doesn't give target repos a way to customize a factory — e.g. swapping
`npm test` for `bun test` in the verify node — without copying the
whole factory file. See `docs/decisions/0008-File-Per-Factory-Composition.md`
for the binding decision.

This change ships the file-per-factory composition story: target repos
declare per-repo customizations in `.minifac/factories/<name>.yaml`
with an `extends:` field that references a built-in (or another local)
factory and overrides only the nodes that differ.

## What to do

Read first:

- `docs/decisions/0008-File-Per-Factory-Composition.md` — binding decision
- `docs/concepts/Factory.md` — current factory concept; "Composition"
  section already gestures at this
- `docs/decisions/0012-Where-State-Lives.md` — where `.minifac/` sits
  in the repo
- Canonical `openspec/specs/factory-schema/spec.md` and
  `openspec/specs/run-cli/spec.md` — current resolution behavior to modify
- `src/cli/resolve.ts` and `src/factory/loader.ts` — current resolver
  + loader; you'll extend both

Then implement what the decision describes. Concretely:

### 1. New resolver lookup order for `factory: <name>`

Today the resolver tries `<cwd>/examples/<name>.yaml`. Extend to:

1. `<cwd>/.minifac/factories/<name>.yaml` (per-repo custom or extended)
2. `<cwd>/examples/<name>.yaml` (built-in shipped with the tool — keep
   this as the v0 home for `minifac:<name>` until a future change
   relocates them into the package itself)

The brief's `factory: minifac:<name>` reference syntax SHALL skip the
local lookup and resolve directly to the built-in
(`<cwd>/examples/<name>.yaml`). Plain `factory: <name>` follows the
two-step precedence above.

### 2. `extends:` in local factory files

- A local factory YAML at `.minifac/factories/<name>.yaml` MAY declare
  a top-level `extends: "<ref>"` field. `<ref>` is one of:
  - `minifac:<built-in-name>` — refers to `examples/<built-in-name>.yaml`
    in the calling repo for v0
  - `<local-name>` — refers to another `.minifac/factories/<local-name>.yaml`
    (recursive extension; loader detects cycles and refuses them)
- Loader resolves `extends:` chains depth-first, merging in the
  documented order:
  - Start from the deepest base; apply each derived layer on top
  - **Replace-at-node-level**: any node whose id is declared in the
    derived layer fully replaces the base layer's node of the same id
  - Edges are replaced wholesale if the derived layer declares an
    `edges:` array; otherwise the base's edges are inherited
  - Top-level fields (`name`, `description`, `brief`) are inherited
    from the base and overridden if the derived layer declares them
- A factory file without `extends:` is loaded as-is (today's behavior)

### 3. Loader behavior

- The loader (`loadFactory`) resolves the full extends chain into a
  single in-memory factory before validation. Validation (start-node,
  cycle budgets, terminal node) runs against the resolved factory.
- Errors during resolution (cyclic `extends:`, missing base, base
  resolves to a path that doesn't exist) surface as
  `FactoryLoadError` with a clear message and the offending file path.

### 4. `minifac init` bootstrap

- New `minifac init` CLI subcommand. Creates the following in `cwd`
  (the target repo):
  - `inputs/` directory (if missing)
  - `.minifac/` directory (if missing)
  - `.minifac/factories/` directory (if missing) with a brief
    `.gitkeep` or README explaining the convention
- Idempotent: re-running `minifac init` on a repo that already has
  the structure is a no-op (or only fills in missing pieces).
- Optionally writes a starter `.minifac/factories/sdd.yaml` that
  `extends: "minifac:sdd"` and overrides nothing — so the user has a
  template to edit. Make this opt-in via `--with-sdd` or similar; do
  not bloat the default.

### 5. Documentation

- Update `docs/concepts/Factory.md` to describe the composition
  mechanism with a small worked example (a `.minifac/factories/sdd.yaml`
  with a custom verify command).
- Add a "Customizing the SDD factory for your repo" section to
  `examples/sdd.md` (or `README.md`, your call) pointing at the
  composition.
- Update the brief schema / authoring docs to mention that the
  `factory:` field can target a local custom factory.

### Spec impact

- `factory-schema`: ADDED requirement(s) for the `extends:` top-level
  field, the resolution rules, and the replace-at-node-level merge
  semantics. Scenarios covering: missing base, cyclic chain,
  replace-at-node-level behavior, edge-array replacement, top-level
  field inheritance.
- `run-cli`: MODIFIED requirement for factory-by-name resolution to
  reflect the two-step lookup precedence and the `minifac:<name>`
  prefix. ADDED requirement for the `init` subcommand.
- `brief-schema`: probably no changes — the `factory:` field's
  resolution rules live in the resolver, not the schema.
- `sdd-factory`: probably no changes for v0; the canonical factory is
  the built-in.

Use your judgment on the exact breakdown. When MODIFYING, copy the
entire requirement block from `openspec/specs/<capability>/spec.md`;
do not partial-paste.

## Out of scope

- **Independent factory versioning** (pinning `minifac:sdd@1` to a
  specific version of the tool's factory templates). The current
  v0 stance per decision 0008 is tool-version-lock; revisit later.
- **Factory registries / multi-repo sharing of custom factories.** A
  repo can copy a `.minifac/factories/<name>.yaml` from another repo
  manually; minifac-native sharing is a future concern.
- **Deep-merge override semantics.** Replace-at-node-level is the v0
  rule; deep-merge can earn its way in later if friction is real.
- **Moving built-in factories out of `examples/`.** For v0 they stay
  where they are; "built-in" means "in `examples/` of the calling
  repo" until a packaging change relocates them.
- **Persistent run history (SQLite).** Separate Phase 3 change.

## Acceptance criteria

- A `.minifac/factories/<name>.yaml` with `extends: "minifac:sdd"` and
  one overridden node loads and produces the merged factory
- A brief saying `factory: sdd` resolves to a local
  `.minifac/factories/sdd.yaml` when present, falling back to
  `examples/sdd.yaml` otherwise
- A brief saying `factory: minifac:sdd` skips the local lookup and
  uses `examples/sdd.yaml` directly
- Cyclic `extends:` chains are rejected at load with a clear error
- Missing base files are rejected at load with a clear error
- `minifac init` creates the expected directory structure idempotently
- All existing tests still pass; new tests cover the composition
  resolver and the init command
