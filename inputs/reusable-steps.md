---
change: reusable-steps
factory: sdd
base_branch: main
---

## Background

Today every [[Factory]] defines all its [[Node]]s inline. The
shipped `examples/sdd.yaml` carries four full node definitions
(propose / apply / verify / archive) with their prompts, executor
config, and templating tokens. A custom factory like
`spec-drift-watch` would need to write all of its nodes from
scratch — even if 80% of the logic overlaps with what's already in
`sdd.yaml`.

[[0008-File-Per-Factory-Composition]] gives whole-factory `extends:`
composition. That's the right tool when you want *mostly the SDD
loop with different verify commands*. It's the wrong tool when you
want to use the SDD's `verify` step inside an unrelated factory —
the step's logic is locked inside its parent factory file with no
way to reference it independently.

The binding decision and rationale live in
`docs/decisions/0018-Reusable-Steps.md`. Read it first. The
concept note at `docs/concepts/Step.md` has the working summary.

This is the keystone open-source-readiness change: it makes
"GitHub Actions for factories" an accurate framing rather than
aspirational, and it enables shipping a richer set of example
factories without each one duplicating prompts.

## What to do

Implement what 0018 describes. Concretely:

### 1. Step schema and loader

- New zod schema for steps in `src/step/schema.ts` (or similar
  location — `src/step/` parallel to `src/factory/`, `src/brief/`,
  etc.):

      name: string (required)
      version: string (required)        # e.g. "1.0.0"
      description: string (optional)
      inputs: record of input definitions (see below)
      executor: string (required)        # "claude" today
      with: object (required)            # executor-specific config

- Input definition shape:

      <input-name>:
        type: "string" | "number" | "boolean" | "array" | "object"
        required: boolean (default false)
        default: any (must match type when present)
        description: string (optional)

- Loader (`src/step/loader.ts`) reads a step YAML, validates with
  zod, returns a typed `LoadedStep` matching `LoadedFactory`'s shape.
  Errors surface as `StepLoadError` with file path + line info
  where available.

### 2. Resolution lookup

Mirror the factory composition resolver from
[[0008-File-Per-Factory-Composition]]:

1. `<cwd>/.minifac/steps/<name>.yaml` (per-repo custom step)
2. `<cwd>/examples/steps/<name>.yaml` (built-in shipped step)
3. Future: external `<scope>/<name>@<version>` registry references
   — out of scope for this change

The `minifac:<name>` prefix on a `uses:` reference skips the local
lookup and resolves directly to `examples/steps/<name>.yaml`.
Bare `<name>` follows the two-step precedence above.

Version pinning syntax (`@1`, `@1.0.0`, unversioned) is parsed but
v0 resolves every reference to the single shipped version
(tool-version-locked, per the ADR).

### 3. Factory node `uses:` field

Extend the factory's node schema (`src/factory/schema.ts`):

- A node may declare `uses: "<ref>"` instead of `executor:` +
  `with:`. The two patterns are mutually exclusive on a single
  node.
- When `uses:` is present, the node MAY also declare `inputs:` (a
  flat key-value map providing values for the step's declared
  inputs).
- Node-level fields stay on the node regardless of `uses:` vs
  inline: `terminal`, `max_iterations`, `cwd`, edges, etc.

### 4. Step reference resolution during factory load

During `loadFactory()`:

- For each node that has `uses:`, resolve the step reference,
  load the step, validate the factory's `inputs:` against the
  step's declared input schema (missing required → error;
  type mismatch → error; unknown input key → error).
- Inline the step's `executor` + `with` into the resolved factory
  node, applying input substitution (see templating below). The
  in-memory factory after load is fully flat — the runner sees
  resolved node definitions, never knows about steps.
- Resolution happens **after** factory `extends:` resolution but
  **before** post-schema validation. Order: extends → step
  inlining → topology validation (cycle budgets, start nodes,
  terminal node).

### 5. Templating scope: `{{ inputs.* }}`

- Inside a step's `prompt` and `with:` strings, `{{ inputs.<name> }}`
  resolves to the value the factory node passed in.
- `{{ brief.* }}` and `{{ run.* }}` continue to work in step
  contexts (they're factory-scoped, propagate through).
- A factory's `inputs:` values can themselves contain `{{ brief.* }}`
  or `{{ run.* }}` — the substitution happens at node dispatch
  time, so:

      nodes:
        propose:
          uses: minifac/openspec-propose@1
          inputs:
            change: "{{ brief.change }}"
            brief_body: "{{ brief.body }}"

  results in `inputs.change` being the brief's change name when
  the propose step's prompt references `{{ inputs.change }}`.

- Stringify non-string types (number, boolean) in prompt
  contexts; preserve typing in non-string `with:` fields. For v0
  document the conservative rule: if you need typed pass-through
  for an executor field, declare the step's `with:` with the
  field already typed and template only string fields.

### 6. Inline node backwards compat

- A factory node WITHOUT `uses:` continues to work exactly as
  today. The factory schema validator accepts both shapes.
- Existing factories (`examples/sdd.yaml` *before* this change)
  load and run unchanged. Migration of `examples/sdd.yaml` to use
  `uses:` happens in this same apply phase but is separable in
  spirit.

### 7. Migrate `examples/sdd.yaml`

- Extract each node's body into a step file:
  - `examples/steps/openspec-propose.yaml`
  - `examples/steps/openspec-apply.yaml`
  - `examples/steps/openspec-verify.yaml`
  - `examples/steps/openspec-archive.yaml`
- Each step declares its inputs (`change`, `brief_body`, `commands`,
  etc.) with proper typing.
- Rewrite `examples/sdd.yaml` to use `uses:` references with
  `inputs:` mapped from the brief. The factory file shrinks
  dramatically; the topology + budgets + edge config remain.
- Update `examples/sdd.md` to show both shapes (inline + uses) and
  point at the new step library.
- The structural test (`src/factory/sdd-example.test.ts`) updates
  to assert the new shape.

### 8. CLI: `minifac steps`

Small addition: a CLI subcommand to list available steps:

      minifac steps [--source local | built-in | all]

Useful for discovery once a meaningful step library exists. Plain
table by default; `--json` for piping. Low priority — defer to a
follow-on if you're running out of budget.

### 9. Tests

- Unit tests for the step loader (valid schema, missing required
  fields, unknown keys, malformed YAML with line info)
- Unit tests for input validation (missing required, type
  mismatch, unknown key, default fill-in)
- Resolution precedence tests (local first, built-in fallback,
  `minifac:` prefix forces built-in, version pin parsing)
- Backwards compat tests (an inline factory still loads correctly)
- Templating tests (`{{ inputs.* }}` substitution; mixed
  `{{ brief.* }}` + `{{ inputs.* }}`)
- The existing SDD structural test still passes against the
  migrated `examples/sdd.yaml`
- A test that loads `examples/sdd.yaml` and asserts the resolved
  factory matches the pre-migration shape exactly (regression
  guard)

### 10. Specs

- NEW capability `step-schema` (or fold into `factory-schema` —
  your judgment) covering the step file format, input schema,
  versioning syntax, resolution precedence, and validation rules.
- `factory-schema`: MODIFIED requirement for nodes to include the
  `uses:` + `inputs:` shape as an alternative to inline
  `executor:` + `with:`. ADDED scenario for backwards-compat
  (inline nodes still work).
- `graph-runner`: MODIFIED requirement for cwd / template
  resolution to include `{{ inputs.* }}` scope inside resolved
  step bodies.
- `run-cli`: ADDED requirement for `minifac steps` if you ship it
  in this change; otherwise note as deferred.
- `sdd-factory`: MODIFIED requirements reflecting the new shape
  of `examples/sdd.yaml`.

When MODIFYING, copy the entire requirement block; do not
partial-paste.

### 11. Documentation

- Update `docs/concepts/Factory.md` — add a "Steps" section
  describing the `uses:` pattern with a small worked example.
- The `docs/concepts/Step.md` concept note already exists from
  this session's prep work — verify it's accurate against what
  shipped; tweak if needed.
- Update `examples/sdd.md` to teach both authoring shapes.
- A short section in the README pitching reusable steps as the
  composition story.

## Out of scope

- **Step marketplace / registry.** Local-only resolution. See
  [[Open-Questions]] "Step marketplace / registry."
- **Step authoring helper** (`minifac step <name>` interactive
  CLI). See Open-Questions.
- **Independent step versioning** (steps SemVer-ing independently
  from the tool). v0 is tool-version-locked.
- **Macro-style includes / non-typed step composition.** Rejected
  per the ADR.
- **Steps in languages other than YAML.** No scripting steps in
  this change.
- **Auto-conversion of existing inline nodes.** Users keep their
  inline factories; migration is opt-in.

## Acceptance criteria

- A step at `examples/steps/openspec-propose.yaml` loads and
  validates
- A factory node with `uses: minifac/openspec-propose@1` resolves
  the step, validates inputs, and runs end-to-end against a real
  invocation
- Missing required input → factory load error citing the step,
  the node, and the missing field
- Type mismatch on an input → similar
- Unknown input key → similar
- `minifac:<name>` prefix forces built-in resolution; bare
  `<name>` does local-then-built-in
- `examples/sdd.yaml` is migrated to use `uses:`; the structural
  test passes; running an existing brief (e.g.
  `inputs/structured-prior-results.md`) against the migrated
  factory produces the same shape of run as before
- A factory without `uses:` (inline nodes) continues to load and
  run unchanged
- All existing tests still pass; new tests cover the steps cases
- `docs/concepts/Factory.md` and `docs/concepts/Step.md` are
  current
