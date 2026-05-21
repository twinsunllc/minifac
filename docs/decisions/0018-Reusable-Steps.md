---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0018: Reusable Steps — granular composition for factories

## Context

Today every [[Factory]] defines all its [[Node]]s inline. The
shipped `examples/sdd.yaml` factory has four node definitions
(propose, apply, verify, archive); a custom `spec-drift-watch`
factory would write all of its nodes from scratch, even if 80% of
the logic — prompt scaffolding, executor config, status criteria —
overlaps with what's already in `sdd.yaml`.

[[0008-File-Per-Factory-Composition]] gives factories *whole-factory*
composition via `extends:`. That's the right answer for "I want
mostly-the-SDD-loop but with a different verify command." It's the
wrong answer for "I want to use the SDD's `verify` *step* inside a
non-SDD factory" — because the step's behavior is locked inside the
parent factory file. No way to publish it independently, no way to
reference it from an unrelated factory.

GitHub Actions resolved exactly this tension: workflows (the
`.github/workflows/*.yml`) compose actions (reusable units like
`actions/checkout@v4`). Workflows declare *what to run*; actions
encapsulate *how each thing runs*. The action marketplace is what
made the model expand beyond any single team.

Reusable steps are to minifac what actions are to GitHub workflows.

## Decision

Introduce **Step** as a new first-class artifact alongside Factory.
A step is a named, versioned, typed-input unit of behavior that a
factory's node can reference via a `uses:` field.

### Step definition

```yaml
# .minifac/steps/openspec-propose.yaml
name: openspec-propose
version: "1.0.0"
description: |
  Scaffold an OpenSpec change and iterate `openspec validate`
  until clean.

inputs:
  change:
    type: string
    required: true
    description: kebab-case change name
  brief_body:
    type: string
    required: true
  model:
    type: string
    required: false
    default: null

executor: claude
with:
  permission_mode: "bypass_permissions"
  prompt: |
    You are running the propose step of the SDD loop for change
    {{ inputs.change }}.

    ## Intent
    {{ inputs.brief_body }}

    Do all of the following:
    [...]
```

### Factory referencing a step

```yaml
nodes:
  propose:
    uses: minifac/openspec-propose@1
    inputs:
      change: "{{ brief.change }}"
      brief_body: "{{ brief.body }}"
```

The factory's node specifies the step reference and the inputs.
Node-level fields like `terminal`, `max_iterations`, and `cwd` stay
on the node (they're per-position in the graph, not per-step).

### Resolution lookup

Modeled on factory composition from [[0008-File-Per-Factory-Composition]]:

1. `<cwd>/.minifac/steps/<name>.yaml` (per-repo custom step)
2. `<cwd>/examples/steps/<name>.yaml` (built-in shipped step)
3. (Deferred) external `<scope>/<name>@<version>` reference resolving
   against a registry — not in v0

### Input typing and validation

- Each step declares `inputs:` with `type` (string / int / bool /
  array), `required` (default false), `default`, and `description`.
- The factory's `inputs:` block on the node MUST satisfy the step's
  declared schema. Loader rejects missing required inputs, type
  mismatches, and unknown input keys.
- Inputs are substituted via `{{ inputs.<name> }}` tokens in the
  step's `prompt`, `with:` fields, and anywhere else the existing
  template substitution applies.

### Templating scopes

- `{{ brief.* }}` — sourced from the [[Brief]] in scope (per
  [[0014-Structured-Prior-Results]] / existing template machinery)
- `{{ run.* }}` — sourced from the [[Run]] (e.g. `run.cwd`)
- `{{ inputs.* }}` — **NEW** — sourced from the factory node's
  declared inputs to the step

Inputs are step-scoped (only valid inside a step definition); briefs
and run are factory-scoped (valid in both).

### Inline node behavior preserved

A factory node MAY still define its behavior inline (no `uses:`,
direct `executor:` + `with:`). Steps are opt-in. Existing factories
without `uses:` continue to work unchanged.

### Versioning syntax

Steps declare a `version:` field. Factories pin to a version:

- `minifac/openspec-propose@1.0.0` — exact pin
- `minifac/openspec-propose@1` — major-version pin (matches latest 1.x)
- `minifac/openspec-propose` — unversioned (matches latest available)

For v0 we ship tool-version-locked semantics: the only available
version of a step is whatever ships in the current minifac. The
versioning syntax is parsed but every reference resolves to the
single shipped version. Independent step versioning is deferred,
same as factory versioning.

## Consequences

- Granular reuse without whole-factory extension. The SDD's `verify`
  step becomes shareable; non-SDD factories can use it without
  copying its prompt.
- A natural surface for community contribution once minifac is
  open-source — anyone can publish a step.
- The "GitHub Actions for factories" framing becomes accurate, not
  aspirational.
- A new authoring workflow: step authoring (alongside brief
  authoring and factory authoring). For v0, hand-written YAML is
  fine; tooling can follow.
- Step migration of shipped `examples/sdd.yaml` is straightforward
  — extract each node's body into `examples/steps/openspec-<phase>.yaml`,
  have the factory reference them via `uses:`. Probably ships as
  part of the same change.
- The runner needs to resolve step references during factory load,
  inline the step definitions into the in-memory factory, and
  validate inputs. All resolution happens before execution.

## Alternatives considered

- **Macro-style includes** (`include: <path>` that splats nodes into
  a factory). Rejected — gives sharing without typed inputs,
  versioning, or validation. Same complexity, less value.
- **Factory composition without step-level reuse** (the existing
  `extends:`). Rejected as insufficient — see Context. Steps
  complement extends rather than replacing it.
- **Steps as functions in a separate language** (Lua, TypeScript,
  WASM, etc.). Rejected for v0 — YAML steps with prompt templates
  fit the existing model, require no sandbox, and don't introduce a
  second authoring surface. A `shell` executor (deferred phase 4)
  already covers most of what scripting steps would need.
- **One unified concept** (no separation between Factory and Step;
  just nested factories). Rejected — Factory is the topology unit;
  Step is the behavior unit. Conflating them loses the GitHub
  Actions analogy and makes typed inputs awkward.

## Open questions (for the proposal phase)

- Exact templating semantics for `{{ inputs.* }}` when the input is
  a non-string type — stringify? Maintain typing through to the
  child process? Probably stringify in `prompt` and `with:` strings;
  pass through typed for object fields.
- How load errors cite the step vs. the factory when validation
  fails — both, ideally, with the factory as the entry point and
  the step as the proximate cause.
- Whether the migration of `examples/sdd.yaml` to use `uses:` ships
  in the same change as the runtime support, or as a follow-on.
- Where step authoring documentation lives — alongside brief and
  factory authoring in `docs/concepts/`.

## Related

- [[Step]] — concept note
- [[Factory]] — what steps live within
- [[Node]] — the topology slot that references a step
- [[Brief]] — flows through to step inputs via `{{ brief.* }}`
- [[0008-File-Per-Factory-Composition]] — whole-factory composition;
  this is the granular sibling
- [[Open-Questions]] — adds step marketplace + step versioning
