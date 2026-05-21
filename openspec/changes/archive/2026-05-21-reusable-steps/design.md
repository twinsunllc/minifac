## Context

Today the factory subsystem lives in two places:

- `src/factory/schema.ts` defines the on-disk shape (Zod, strict on
  extras). Each node carries `executor: string` and an opaque `with:`
  map directly.
- `src/factory/loader.ts` reads a single YAML file (after
  `extends:` resolution by `src/factory/extends.ts`), validates with
  the strict schema, and runs post-schema validation
  (start nodes, terminal node, cycle budgets, edge endpoints).

The runner sees the loaded `Factory` and never knows where a node
came from. Brief/run substitution happens in
`src/factory/templating.ts` (the `applyBriefAndRunTokens` family)
immediately before dispatch.

Whole-factory composition (`extends:`) has been shipping since
ADR 0008. It solved the "I want most of the SDD loop but a different
`verify`" use case. It does not solve the "I want to use the SDD's
`verify` *step* from an unrelated factory" use case, because the
step's behavior is locked inside the parent factory file.

ADR 0018 (`docs/decisions/0018-Reusable-Steps.md`) settles the
shape: a Step is a new first-class artifact alongside Factory. A
step is a named, versioned, typed-input unit of behavior. A factory
node references it via `uses:`. Inline behavior is preserved.

## Goals / Non-Goals

**Goals**

- Granular reuse without whole-factory extension. The SDD's `verify`
  step becomes shareable; non-SDD factories use it without copying
  prompts.
- A typed-input contract between factory and step. Missing
  required input, type mismatch, and unknown key are load-time
  failures with file-and-line citations, not runtime surprises.
- Backwards compatibility. Existing inline factories load and run
  unchanged; migration is opt-in.
- A canonical built-in step library that the shipped
  `examples/sdd.yaml` is migrated onto, dogfooding the mechanism
  end-to-end.
- Resolution precedence that mirrors factory composition so users
  don't have to learn two lookup mental models.
- Minimal surface area: the runner is unchanged. Steps inline into
  flat node definitions at load time. The runner never sees a step.

**Non-Goals (v0)**

- Step marketplace / external registry. Local-only lookup. Filed in
  [[Open-Questions]] as "Step marketplace / registry."
- Step authoring tooling (`minifac step <name>` interactive CLI).
  Filed in [[Open-Questions]].
- Independent step versioning. Steps SemVer-ing apart from the tool
  is deferred — every shipped reference resolves to the version
  bundled with the current minifac (tool-version-locked).
- Macro-style includes / un-typed `include:`. Rejected per ADR 0018:
  same complexity, less value.
- Scripting steps in languages other than YAML. The `shell` executor
  (phase 4, separate effort) covers most of what scripting steps
  would need; in this change steps are YAML-only.
- Auto-conversion of existing inline factories. Users keep their
  inline shape; migration is opt-in. The shipped `examples/sdd.yaml`
  is migrated as a deliberate dogfooding choice.

## Decisions

### Decision: New `step-schema` capability, not a fold into `factory-schema`

A Step is a different kind of artifact than a Factory — it has
its own file shape, its own validation rules (typed input schema
with type-checked defaults), its own resolution precedence, and
its own versioning syntax. Folding all of that under
`factory-schema` would mean a single spec covering two
substantially different on-disk shapes, with scenarios that all
need to disambiguate which they are about.

**Rejected alternative.** Add a "Step file format" section to
`factory-schema`. Cheaper to write upfront, more confusing for
readers later. The schema's strict-on-extras rule and the
canonical "factory has a `nodes` map" framing would collide with
the step's "no nodes, no edges, just executor+with" shape.

### Decision: `uses:` and inline are mutually exclusive on a node

A node either declares `executor:` + `with:` directly, or it
declares `uses:` (with optional `inputs:`) and inlines the step's
executor + with. Allowing both — e.g. `uses: openspec-verify` plus
an inline `with: { permission_mode: ... }` that overlays the step's
`with:` — sounds useful but breaks the typed-input contract: any
field the inline overlay touches sidesteps input validation.

If a user wants to override a step's behavior, they declare it
inline (drop `uses:`) and write what they want. If they want a
variant, they declare a new step (or extend the existing one when
step extension lands — out of scope here). Either way the
contract between factory and step stays clean.

**Rejected alternative.** Allow inline `with:` overlays on top of
`uses:`. Pushes the mental model toward "steps are partial node
definitions" rather than "steps are first-class reusable
behaviors." Also opens the door to surprising precedence rules.

### Decision: Inline steps at load time, not at dispatch

When `loadFactory()` encounters a node with `uses:`, the loader
resolves the reference, validates the inputs, applies
`{{ inputs.* }}` substitution into the step's `executor` + `with`,
and rewrites the node in place to a flat inline node. The runner
sees nothing but flat nodes; it doesn't have a "step" concept.

This is the cheap, conservative choice. The runner is already
substituting `{{ brief.* }}` and `{{ run.* }}` at dispatch time
(per the `graph-runner` spec's "Brief token substitution"
requirement). Inputs are substituted earlier — at load — because
their values are factory-static (they come from the factory's
`inputs:` map on the node), not run-static. The only twist is
that factory `inputs:` values may themselves contain
`{{ brief.* }}` or `{{ run.* }}` tokens — those are NOT resolved
at load (the brief / run is not in scope) and instead survive
into the inlined string for the runner to resolve at dispatch.

**Rejected alternative.** Resolve steps at dispatch time. Would
require the runner to know about steps, threading step
definitions through the executor interface. Doubles the surface
area for a v0 mechanism whose typed-input contract is the
load-time validation, which has to happen before the runner runs
anyway.

### Decision: `{{ inputs.* }}` is a third namespace alongside `{{ brief.* }}` and `{{ run.* }}`

The factory templating layer already supports `brief.*` and
`run.*`. `inputs.*` slots into the same grammar (`{{ <ns>.<field>
}}`) and shares the same "unknown identifier passes through
verbatim" default behavior. The substitution semantics are
identical; only the scope and timing differ.

`inputs.*` is step-scoped: it only resolves inside the inlined
body of a step (because that is the only place a factory's
node-level `inputs:` map is in scope). `brief.*` and `run.*` are
factory-scoped (they are valid in both inline and step bodies).

This avoids growing two competing template syntaxes. Users learn
one rule, three namespaces.

### Decision: Strings get stringification; non-strings pass through typed

A step's `inputs:` schema permits `string` | `number` | `boolean`
| `array` | `object`. When `{{ inputs.flag }}` appears inside a
string field (e.g. `prompt:`), the value is stringified
(`String(value)`). When the field being templated is itself a
non-string type in the step's `with:` (e.g. an array field
declared verbatim), the input value passes through with its type
preserved by structural assignment, not text replacement.

For v0 we document a conservative rule for step authors: if you
need typed pass-through for an executor field, declare the
field's value directly in the step's `with:` as the typed value
(referencing the input by structural lookup, not by `{{ }}`
substitution into a string). The string-template path is for
string fields only.

**Rejected alternative.** Pass-through typing through string
templates (e.g. when a prompt contains nothing but
`{{ inputs.commands }}`, deliver the array). Magical; surprising.
Better to make the typed path the structural-reference path.

### Decision: Reference syntax — `minifac:<name>`, `<scope>/<name>@<version>`, bare `<name>`

The reference grammar reuses the factory composition convention
where it can:

- `minifac:<name>` — built-in. Resolves to
  `<cwd>/examples/steps/<name>.yaml`. Skips the local lookup.
- `<scope>/<name>` or `<scope>/<name>@<version>` — namespaced
  reference. The version is parsed (e.g. `@1`, `@1.0.0`) but
  ignored in v0 (tool-version-locked). For v0, `<scope>/<name>`
  references resolve via the same two-step lookup as bare names
  (local first, then built-in). The `<scope>/` prefix is a
  forward-compatible namespacing hint for the future registry but
  carries no runtime semantics in v0 beyond being preserved in
  error messages.
- `<name>` — bare name. Tries `<cwd>/.minifac/steps/<name>.yaml`
  first, then `<cwd>/examples/steps/<name>.yaml`.

`minifac/<name>` and `minifac/<name>@1` are common shapes that
appear in the ADR's examples. They resolve like any other
`<scope>/<name>` — local first, then built-in — but the `minifac/`
scope is by convention reserved for the bundled steps.

**Rejected alternative.** A more elaborate grammar (e.g. URI-like
`step://...`). Premature — we have one resolution backend.

### Decision: Inlining order — `extends:` → step inlining → post-schema validation

The loader's existing pipeline is: read YAML → parse against
`FactoryLayerSchema` (permissive — `nodes` and `edges` optional)
→ resolve `extends:` chain into merged factory → re-validate the
merged factory against `FactorySchema` (strict) → post-schema
validation (start node, terminal, cycle budgets).

Step inlining slots in between extends resolution and post-schema
re-validation:

1. Read the entry-point factory file.
2. Resolve the `extends:` chain into a single merged in-memory
   factory (unchanged from today).
3. For each node in the merged factory that declares `uses:`,
   resolve the step, validate the node's `inputs:` against the
   step's input schema, substitute `{{ inputs.* }}` into the
   step's `executor` + `with`, and replace the node body in
   place. The resolved node carries `executor` + `with` and no
   `uses:` / `inputs:` fields.
4. Run post-schema validation against the resulting flat
   factory.

This ordering is correct because the typed-input contract
between a node and the step it `uses:` is a property of the
*resolved* factory (after extends), not of any individual layer.
An extends-derived layer can override a node from `inline:` to
`uses:`, or vice versa; what matters is the shape that survives.

### Decision: Error citation — both the factory and the step

When step resolution or input validation fails, the error names
both files: the factory (entry point) and the step (proximate
cause). The factory is the operator-actionable file (it is where
the `uses:` reference lives); the step is the documented contract
the operator is failing to satisfy. Error messages SHALL contain
both. The shape can be modeled on the existing
`FactoryLoadError`'s `sourcePath`; a new `StepLoadError` is
introduced for errors that originate in the step itself (e.g.
malformed step YAML, schema violations in the step's own
declared inputs).

### Decision: `minifac steps` discovery subcommand ships in this change

Not strictly required for the mechanism to work, but cheap to add
and high-value for the first users of the system. Plain table
output by default (`name`, `version`, `source`, `description`);
`--json` for piping; `--source local | built-in | all` filter.
No mutations, no network calls, no `git` invocations. Defer the
authoring CLI (`minifac step <name>`) per the open question.

## Risks / Trade-offs

- **Risk:** A factory author mis-spells an input key and the typed
  validation passes (because typo input is treated as "unknown
  key", which is rejected — good) but a step author later adds a
  new optional input with the same shape and the typo silently
  resolves. → Mitigation: unknown input keys are a hard error.
  Optional inputs still must be declared in the step's schema; an
  unknown key in the factory's `inputs:` is rejected even if the
  step author later adds a same-named input — the failure happens
  at load against the current step schema.
- **Risk:** Templating a non-string input into a string field
  yields surprising stringification (e.g. an object → `[object
  Object]`). → Mitigation: document the rule (strings stringify,
  non-strings pass through structurally when the field's typed
  value is the input directly). Loader emits a warning in v0 when
  a `{{ inputs.<name> }}` token inside a string field references
  an input typed `object` or `array`; v1 may upgrade this to an
  error once usage patterns are visible.
- **Risk:** Version pinning syntax is parsed but ignored in v0,
  which could lure users into thinking pins are meaningful and
  later break when independent versioning lands. → Mitigation:
  `docs/Open-Questions.md` already names "Independent step
  versioning" as deferred. The `Step.md` concept note and the
  `step-schema` spec both call out that v0 is tool-version-locked.
  No promises broken at v1: pinned references continue to resolve
  to the bundled version; once independent versioning lands, a
  pin to `@1` continues to match what it matches today (the
  shipped 1.x).
- **Risk:** The SDD factory migration changes the on-disk shape of
  `examples/sdd.yaml` and the structural test
  (`src/factory/sdd-example.test.ts`) has to update in lockstep,
  which makes it easier to silently drift the contract. →
  Mitigation: a regression test loads the migrated
  `examples/sdd.yaml` via `loadFactory`, snapshots the *resolved*
  factory (post step inlining), and deep-equals it against the
  pre-migration shape (modulo prompt-string normalization for
  whitespace). The structural test now asserts on the resolved
  factory's node shape, which is the property that has to remain
  stable for runtime behavior.
- **Risk:** Two namespaces for the same prompt syntax (`{{
  brief.* }}`, `{{ run.* }}`, `{{ inputs.* }}`) can confuse step
  authors about what is in scope when. → Mitigation: docs are
  explicit — `Step.md` lists each namespace and when it is in
  scope; the `step-schema` spec encodes the rule normatively;
  scenarios in the `graph-runner` modified requirement cover the
  three-way interaction.
- **Trade-off:** Step inlining at load time means a step body
  cannot conditionally adapt based on per-iteration runtime state
  (the brief and run are in scope, but the runner's history /
  `priorResults` are not). For v0 this matches reality — every
  shipped node body today is a static prompt with template
  substitution; conditional logic happens inside the executor
  (the Claude session) by reading `ctx.priorResults`. A future
  "step macros" feature could lift this, filed implicitly by ADR
  0018's rejection of macro-style includes.

## Migration Plan

1. Land the step subsystem (schema, loader, resolver, inliner) and
   the factory's `uses:` field behind no flag. Inline nodes keep
   working; the only behavior change is that a node may now
   declare `uses:`.
2. Author the four built-in steps under `examples/steps/` (one per
   SDD phase). Each declares its inputs (`change`, `brief_body`,
   `commands`, etc.) with proper typing and defaults.
3. Rewrite `examples/sdd.yaml` to reference the steps via `uses:`,
   with `inputs:` mapped from the brief. The factory file shrinks
   from ~150 lines to ~40. Topology, budgets, edges, and
   `brief: required` are unchanged.
4. Update the structural test
   (`src/factory/sdd-example.test.ts`) to assert against the
   resolved factory's shape. Add a regression test that loads the
   pre-migration `examples/sdd.yaml` snapshot (committed as a
   fixture or reconstructed inline) and deep-equals the resolved
   post-migration factory against it.
5. Update docs: `Factory.md` adds a Steps section; `Step.md` is
   verified; `examples/sdd.md` teaches both shapes; README pitches
   reusable steps as the composition story.
6. Add the `minifac steps` CLI subcommand.

No rollback strategy is needed — the change is additive (new file
shape, new node field) plus a migration of one shipped factory.
Reverting the migration is a single commit; reverting the
subsystem is a single revert of the step source tree.

## Open Questions

- Should `minifac steps` accept a positional `<name>` filter for
  searching? Probably yes, but defer to a follow-on; the table /
  `--source` shape covers v0.
- Where do "scope" prefixes (`minifac/`, third-party scopes) live
  once a registry exists? Filed under [[Open-Questions]] "Step
  marketplace / registry."
- Is there a need for a `step:` brief field analogous to
  `factory:`? No — a brief always targets a factory, never a
  step. Steps are referenced by factory nodes, not by briefs.
- Will future step extension (a `extends:` on a step itself) need
  this design to change? Not significantly — extension would
  resolve at step-load time, before the factory inliner pulls the
  step in. The step schema would gain an `extends:` field; the
  factory side is unchanged.
