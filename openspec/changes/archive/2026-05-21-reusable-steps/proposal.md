## Why

Today every [[Factory]] defines all of its [[Node]]s inline. The shipped
`examples/sdd.yaml` carries four full node definitions
(propose / apply / verify / archive) with their prompts, executor
config, and templating tokens. A custom factory like
`spec-drift-watch` would need to write all of its nodes from
scratch — even if 80% of the logic overlaps with what already lives
in `sdd.yaml`.

[[0008-File-Per-Factory-Composition]] gives whole-factory `extends:`
composition. That is the right tool when you want *mostly the SDD
loop with different verify commands*. It is the wrong tool when you
want to use the SDD's `verify` step inside an unrelated factory —
the step's logic is locked inside its parent factory file with no
way to reference it independently.

This change introduces **Step** as a reusable, versioned, typed-input
unit of behavior that a factory's node can reference via `uses:`.
Steps are to minifac what actions are to GitHub workflows: workflows
declare *what* to run; actions encapsulate *how* each thing runs.

The binding decision and rationale live in
`docs/decisions/0018-Reusable-Steps.md`; the concept note is at
`docs/concepts/Step.md`. This is the keystone open-source-readiness
change — it makes "GitHub Actions for factories" an accurate framing
rather than aspirational, and unlocks a richer set of example
factories without each one duplicating prompts.

## What Changes

- **New Step artifact and schema.** A YAML file with `name`,
  `version`, optional `description`, `inputs` (typed schema),
  `executor`, and `with`. A loader (`src/step/loader.ts`)
  reads, validates, and returns a typed `LoadedStep`.
- **Step input schema.** Each input declares `type` (`string` |
  `number` | `boolean` | `array` | `object`), `required` (default
  `false`), `default` (must match `type` when present), and an
  optional `description`. The loader validates these and rejects
  unknowns.
- **Step reference resolution.** Mirrors factory composition:
  `<cwd>/.minifac/steps/<name>.yaml` first, then
  `<cwd>/examples/steps/<name>.yaml`. The `minifac:<name>` prefix
  skips local and resolves to the built-in. Version-pin syntax
  (`@1`, `@1.0.0`, unversioned) is parsed but every reference
  resolves to the single shipped version in v0 (tool-version-locked,
  per ADR 0018).
- **Factory node `uses:` field.** A node may declare `uses: "<ref>"`
  instead of inline `executor:` + `with:`. The two patterns are
  mutually exclusive on a single node. A node with `uses:` MAY also
  declare an `inputs:` map providing values for the step's declared
  inputs. Node-level fields stay on the node (`terminal`,
  `max_iterations`, `cwd`, edges).
- **Inlining at load time.** During `loadFactory()` — after
  `extends:` resolution and before post-schema validation — each
  node with `uses:` resolves its step reference, validates the
  factory's `inputs:` against the step's declared schema, and is
  rewritten to a flat inline node by inlining the step's `executor`
  and `with` (with `{{ inputs.* }}` substituted from the factory's
  input mapping). The runner never sees steps; it only sees flat
  resolved nodes.
- **New `{{ inputs.* }}` templating scope.** Inside a step body,
  `{{ inputs.<name> }}` resolves to the value the factory node
  passed in. `{{ brief.* }}` and `{{ run.* }}` continue to apply
  unchanged. A factory's `inputs:` values MAY themselves contain
  `{{ brief.* }}` / `{{ run.* }}`; brief/run substitution happens
  at node-dispatch time so the inlined input string is the
  brief/run-resolved value.
- **Backwards-compat for inline nodes.** A factory node without
  `uses:` continues to work exactly as today. Existing factories
  (`examples/hello.yaml`, third-party factories) load unchanged.
- **Migrate `examples/sdd.yaml` onto `uses:`.** Extract each node's
  body into `examples/steps/openspec-propose.yaml`,
  `openspec-apply.yaml`, `openspec-verify.yaml`,
  `openspec-archive.yaml`. Rewrite the factory to reference the
  steps. The topology, budgets, edges, and `brief: required`
  declaration are unchanged.
- **`minifac steps` CLI subcommand.** Discovery aid that lists the
  available steps (local + built-in). Plain table by default,
  `--json` for piping, `--source local|built-in|all` filter.

## Capabilities

### New Capabilities

- `step-schema`: defines the on-disk shape of a step YAML file,
  the input schema (types, required, defaults), the reference and
  version-pinning syntax, and the lookup precedence for resolving
  `<ref>` against `.minifac/steps/` and `examples/steps/`.

### Modified Capabilities

- `factory-schema`: ADDED requirement for nodes to allow `uses:` +
  `inputs:` as an alternative to inline `executor:` + `with:`, with
  the mutual-exclusion rule, the input-validation rules (missing
  required → error, type mismatch → error, unknown key → error),
  and the load-time inlining contract (inline-before-post-schema-
  validation, after `extends:` resolution). ADDED scenarios for
  the backwards-compat case (inline nodes still work).
- `graph-runner`: MODIFIED the "Brief token substitution" requirement
  to recognize the `inputs` namespace as a third valid scope inside
  resolved node bodies, with rules consistent with `brief.*` and
  `run.*` (substitute when in scope; leave verbatim when not).
- `run-cli`: ADDED `minifac steps` subcommand requirement.
- `sdd-factory`: MODIFIED requirements that bound the on-disk shape
  of `examples/sdd.yaml` (the "prompts substitute brief fields"
  requirement and the "cwd is `{{ run.cwd }}`" requirement) so they
  bind the shape of the underlying steps now that each node uses
  `uses:` rather than carrying inline `prompt:` and `cwd:` strings.
  The runtime contract per-node (success criteria, sentinel usage,
  authority controls) is unchanged.

## Impact

- **New code.** `src/step/schema.ts`, `src/step/loader.ts`,
  `src/step/resolve.ts` (paralleling `src/factory/`),
  `src/step/inline.ts` (the helper that splats a step into a
  factory node), `src/cli/steps.ts` for the discovery subcommand.
- **Modified code.** `src/factory/schema.ts` gains the `uses:` /
  `inputs:` shape on the node layer schema (still strict on
  extras). `src/factory/loader.ts` runs step inlining between
  `extends:` resolution and post-schema validation. `src/factory/
  templating.ts` (or wherever brief/run substitution lives) gains
  the `inputs` namespace.
- **New on-disk files.** `examples/steps/openspec-propose.yaml`,
  `openspec-apply.yaml`, `openspec-verify.yaml`,
  `openspec-archive.yaml`. The migrated `examples/sdd.yaml`
  shrinks dramatically.
- **Tests.** Step loader tests (schema + I/O), input-validation
  tests, resolution-precedence tests, backwards-compat tests for
  inline factories, templating tests for `{{ inputs.* }}`, a
  regression test confirming the migrated `examples/sdd.yaml`
  loads to the same resolved factory shape as the pre-migration
  one (deep-equal modulo prompt-string normalization), the existing
  structural test (`src/factory/sdd-example.test.ts`) updated for
  the new shape, and a `minifac steps` CLI test.
- **Documentation.** `docs/concepts/Factory.md` gains a "Steps"
  section with a worked `uses:` example; `docs/concepts/Step.md`
  is verified against what shipped; `examples/sdd.md` teaches
  both authoring shapes; README gains a short reusable-steps
  pitch.
- **Out of scope** (deferred per ADR 0018 and
  `docs/Open-Questions.md`): step marketplace / registry; the
  `minifac step <name>` interactive authoring CLI; independent
  step versioning (steps SemVer-ing apart from minifac);
  macro-style includes; non-YAML scripting steps;
  auto-conversion of existing inline nodes.
