## Context

The factory model lives in two files today:

- `src/cli/resolve.ts` resolves `minifac run <thing>` to a brief, a
  brief-implied factory, or a brief-less factory by trying
  `<thing>` as a path, then `inputs/<thing>.md`, then
  `examples/<thing>.yaml`.
- `src/factory/loader.ts` reads one YAML file, parses with the
  `FactorySchema` (Zod, `.strict()`), and runs post-schema
  validations (edge endpoints, start node, terminal node, cycle
  budgets).

Both assume one factory = one file. Decision
[[0008-File-Per-Factory-Composition]] adds two-layer composition:
shared infrastructure ships with the tool (`minifac:<name>`,
currently aliased to `examples/<name>.yaml`); per-repo
customizations live at `.minifac/factories/<name>.yaml` and
optionally `extends:` a base.

The dogfood scenarios that drove this:

1. A consumer repo wants the SDD factory's flow but with a
   different verify command. Today they fork the YAML; tomorrow
   they want a one-node override that survives upstream
   `minifac:sdd` changes.
2. The same repo also runs a `release-notes` factory of its own
   that doesn't extend anything. The mechanism must support
   "custom from scratch" too, not just override.
3. minifac itself dogfoods through `examples/` and has no
   `.minifac/` of its own. The lookup precedence must let the
   pre-existing examples/ flow keep working.

## Goals / Non-Goals

**Goals**

- Per-repo customization of canonical factories with one file per
  factory, override per node.
- A clear, prefix-based escape hatch (`minifac:<name>`) for briefs
  that want the canonical factory and nothing else.
- Load-time failure with a clear message for the predictable
  mistakes (cycle in `extends:`, missing base, base id that doesn't
  resolve, override referencing a renamed node — surfaces
  naturally as a validation failure on the resolved factory).
- A `minifac init` that creates the structure idempotently so users
  don't have to memorize the layout.

**Non-Goals (v0)**

- Independent factory SemVer / pinning to a specific minifac
  version of a built-in factory. The decision pins to
  "tool-version-locked" for v0.
- Multi-repo sharing of custom factories via a registry.
- Deep-merge override semantics. Replace-at-node-level only.
- Moving the built-in factories out of `examples/` and into the
  package. `minifac:<name>` is a v0 alias for
  `<cwd>/examples/<name>.yaml`.
- Persistent run history.

## Decisions

### Decision: Resolution order for `factory: <name>` is local-then-built-in, with an explicit `minifac:` prefix to skip the local lookup

The brief's `factory:` field SHALL resolve as:

- `factory: minifac:<name>` — skip local lookup; resolve directly
  to `<cwd>/examples/<name>.yaml`. Errors if that path is missing.
- `factory: <name>` (no prefix) — try
  `<cwd>/.minifac/factories/<name>.yaml` first; if missing, fall
  back to `<cwd>/examples/<name>.yaml`. Errors if neither exists.

**Rationale**: matches the decision document verbatim. Locals win
by default so a repo with a custom `sdd.yaml` doesn't have to
update every brief; the `minifac:` prefix is the documented escape
hatch when a brief wants the canonical factory regardless of what
the repo has overridden. The prefix is on the brief, not the CLI
arg, because briefs are the durable artifact — the CLI arg is
ephemeral.

**Alternatives considered**:

- *Built-in wins by default.* Rejected — defeats the point of
  per-repo customization. Most repos will customize once and want
  every brief to inherit that customization.
- *No prefix, always check local.* Rejected — leaves no way for a
  brief to bypass a local override, which the decision document
  calls out as needed.

### Decision: `extends:` is resolved into a single in-memory factory before validation

The loader expands the `extends:` chain depth-first, applying
derived layers on top of the base in this order:

1. Resolve the chain to a list (deepest base first, current
   layer last). Detect cycles by tracking visited absolute paths;
   any repeat is a `FactoryLoadError`.
2. For each layer (after the base), merge into the accumulator:
   - **Nodes**: `accumulator.nodes[id] = layer.nodes[id]` for every
     id declared in the layer. Nodes not redeclared are preserved
     intact (no field-level merging). This is the
     replace-at-node-level rule.
   - **Edges**: if the layer declares `edges:` (even an empty
     array), replace `accumulator.edges` entirely. If the layer
     omits `edges:`, inherit unchanged.
   - **Top-level fields** (`name`, `description`, `brief`): if the
     layer declares the field, overwrite; else inherit.
3. After all layers are applied, strip `extends:` from the
   accumulator and run the existing schema + post-schema
   validation against the result.

**Rationale**: validating after the merge means cycle budgets,
terminal node, start node, and edge endpoints are checked on the
factory that will actually run. A user who overrides a node such
that no node is terminal gets the same error today's loader gives
on a non-extending factory. The base-deepest-first ordering
follows YAML/JSON convention; the override layer is the "last
write wins" file.

**Alternatives considered**:

- *Validate each layer in isolation.* Rejected — produces
  spurious errors (e.g. a base whose terminal node is overridden
  is fine; isolated, the override layer looks terminal-less).
- *Deep-merge node fields.* Explicitly rejected by the decision:
  ambiguous array semantics, and the cost of copying a whole node
  to change one field is small at v0 scale.

### Decision: `minifac:<name>` is a v0 alias for `<cwd>/examples/<name>.yaml`

The `minifac:` prefix resolves to the calling repo's
`examples/<name>.yaml` until a future packaging change relocates
built-in factories into the npm package itself. This matches
decision 0008's tool-version-lock stance: a future change can
flip the resolver to look inside the installed package without
breaking any brief that already uses `minifac:sdd`.

**Rationale**: shipping a packaged-built-ins resolver requires
deciding how to bundle YAML in an npm package, how to discover
the package path from a global `minifac` install, and how that
interacts with `npm link` and `pnpm`. That's a separate change.
The brief syntax (`minifac:sdd`) is forward-compatible: the
resolver is the only thing that changes.

### Decision: `minifac init` is opt-in for the starter `sdd.yaml`

`init` always creates `inputs/`, `.minifac/`, and
`.minifac/factories/` (with a small README/.gitkeep explaining
the convention). It writes a starter
`.minifac/factories/sdd.yaml` only if `--with-sdd` is supplied.

**Rationale**: most repos using minifac will not need to
customize the SDD factory at all (they'd reference
`factory: minifac:sdd` from their brief, or `factory: sdd` and let
the resolver fall through to the built-in). Writing a starter
file by default creates a dead file the user has to either edit
or delete. Opt-in keeps the default invocation pure structure.

### Decision: Loader exports stay stable; chain resolution lives next to the loader

The public `loadFactory(sourcePath: string): Promise<LoadedFactory>`
signature does not change. The resolver-of-`extends` logic lands
either inside `src/factory/loader.ts` (as a private helper) or in a
sibling `src/factory/extends.ts` that the loader imports. Callers
(`cli.ts`, `runner/`, `serve/`) see the same `LoadedFactory`
shape and `sourcePath` field; `sourcePath` is the path of the
top-most file the user/CLI passed in, not any of the bases.

**Rationale**: the runner and event-output paths shouldn't care
that composition happened. The `sourcePath` field is the entry
point — that's what was on disk that the user pointed at.
Reporting a base path in error messages would confuse users who
edited the override file.

**Open**: whether `LoadedFactory` should grow a `composedFrom:
string[]` field for debugging. Deferred — add when the daemon or
viewer needs it.

## Risks / Trade-offs

- **Schema-level vs loader-level enforcement of `extends:` value
  shape.** The Zod schema accepts an optional string; the
  `minifac:` prefix check lives in the loader. If users write
  `extends: minifaq:sdd`, they get a "missing local factory
  `minifaq:sdd`" error, not a more specific "did you mean
  `minifac:`?" error. Acceptable for v0; can sharpen later.
- **Override targeting a renamed node.** If
  `minifac:sdd` renames a node from `verify` to `check`, a
  consumer's `.minifac/factories/sdd.yaml` overriding `verify:`
  results in a factory with both `verify` (the override) and
  `check` (from the base) — which probably means the base's
  edges still reference `check` and the user's override is
  orphaned. The existing edge-validation will fail if edges
  reference the orphaned override; if not, the override silently
  does nothing. Mitigation: the decision document calls this out
  as the right failure mode at v0 (users will notice when their
  override stops applying after an upgrade). Future change can
  add a warning when a node id in the layer doesn't exist in any
  base.
- **`minifac init` writing to user's repo.** Idempotent and only
  touches `inputs/`, `.minifac/`, and (with `--with-sdd`)
  `.minifac/factories/sdd.yaml`. No network, no git, no other
  side effects. Risk surface is small.
- **The `examples/` fallback collides with the v0 stopgap in
  `run-cli`.** Today `examples/<name>.yaml` is also where
  `minifac run <factory-name>` looks for brief-less factories.
  Composition doesn't change that — both resolve through the
  same lookup. Future packaging change to relocate built-ins
  will touch both sites together.

## Migration Plan

This is additive. Existing factories continue to load as today
because:

- The schema's new `extends:` field is optional.
- Loaders without an `.minifac/factories/<name>.yaml` fall
  through to the existing `examples/<name>.yaml` lookup
  unchanged.
- The existing brief `factory:` field syntax (`factory: sdd`) is
  preserved — only the prefix `minifac:sdd` form is new.

No existing brief or factory needs to change. Repos that want to
customize a built-in run `minifac init` and create a small
`.minifac/factories/<name>.yaml`.

## Open Questions

- Whether to add a `--print-resolved` debug flag (or `minifac
  show <factory>`) that dumps the merged factory after
  `extends:` resolution. Useful for debugging composition; not
  strictly required for v0. Defer until the merge surface gets
  more complex.
- Whether to emit a warning when a layer's node id doesn't exist
  in the base (orphan-override detection). Defer per
  Risks/Trade-offs above.
