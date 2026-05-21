---
tags: [concept]
aliases: [steps, reusable-step]
---

# Step

A **Step** is a reusable, versioned, typed-input unit of behavior
that a [[Factory]] [[Node]] can reference instead of defining its
behavior inline.

The relationship: Factory is the topology (which nodes, which edges,
which cycles); Step is the per-node behavior (what to do, what
inputs it takes, what executor runs it). Same shape as GitHub
Actions: a workflow's `jobs.<job>.steps.<step>` can be inline OR
reference a published action via `uses:`. Minifac follows the same
pattern.

## Anatomy

A step is a YAML file with:

- `name` + `version` — identity and pinning
- `description` — human prose
- `inputs` — typed schema (name → type, required, default, description)
- `executor` — which executor runs this step (`claude` today)
- `with` — the executor-specific config, templated against
  `{{ inputs.* }}`

## Where steps live

- **Per-repo custom**: `.minifac/steps/<name>.yaml`
- **Built-in shipped**: `examples/steps/<name>.yaml`
- **External, future**: published references resolving against a
  registry. Deferred.

## How factories use steps

```yaml
nodes:
  propose:
    uses: minifac/openspec-propose@1
    inputs:
      change: "{{ brief.change }}"
      brief_body: "{{ brief.body }}"
  apply:
    uses: minifac/openspec-apply@1
    inputs:
      change: "{{ brief.change }}"
  verify:
    uses: minifac/openspec-verify@1
    inputs:
      commands: ["npm test", "npm run build", "npm run check"]
  archive:
    uses: minifac/openspec-archive@1
    inputs:
      change: "{{ brief.change }}"
    terminal: true
```

Node-level fields (`terminal`, `max_iterations`, `cwd`) stay on the
node — they describe the node's position in the graph, not the
step's behavior.

## Templating scopes inside a step

- `{{ inputs.* }}` — the factory node's declared inputs to this
  step. Only valid inside step definitions.
- `{{ brief.* }}` — fields from the [[Brief]] in scope (`change`,
  `body`, `factory`, etc.). Valid in both step and factory
  contexts; flows through via the factory's input mapping.
- `{{ run.* }}` — fields from the [[Run]] (e.g. `run.cwd` for the
  [[Worktree]] path).

## Inline behavior is still allowed

Factories can still inline a node's behavior fully without using
`uses:`. Steps are opt-in. Existing factories that don't reference
steps continue to work unchanged.

## Versioning

For v0, step versions are tool-version-locked — the shipped version
of minifac dictates which step versions exist. The reference syntax
(`@1`, `@1.0.0`) is parsed but resolves to the bundled version.
Independent step versioning is filed under [[Open-Questions]] as a
future concern.

## Related

- [[Factory]] — composes steps via nodes' `uses:` field
- [[Node]] — topology slot that references a step
- [[Brief]] — flows through to step inputs
- [[Run]] — provides `{{ run.* }}` templating
- [[0018-Reusable-Steps]] — binding decision
- [[0008-File-Per-Factory-Composition]] — whole-factory composition
  (sibling pattern)
