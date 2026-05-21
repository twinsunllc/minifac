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

- **Per-repo custom**: `<callerCwd>/.minifac/steps/<name>.yaml`
- **Built-in shipped**: `<callerCwd>/examples/steps/<name>.yaml`
- **External, future**: published references resolving against a
  registry. Deferred.

## Reference syntax and lookup precedence

The `uses:` field on a node accepts three forms:

- `minifac:<name>[@<version>]` — built-in only. Skips the local lookup
  and resolves directly to `<callerCwd>/examples/steps/<name>.yaml`.
- `<scope>/<name>[@<version>]` — namespaced. In v0 the `<scope>/`
  prefix carries no runtime semantics beyond being preserved in error
  messages; lookup follows the bare-name precedence below.
- `<name>[@<version>]` — bare. Tries
  `<callerCwd>/.minifac/steps/<name>.yaml` first; if absent, falls
  back to `<callerCwd>/examples/steps/<name>.yaml`.

The `@<version>` pin is parsed off the reference but ignored for path
resolution in v0 — every reference resolves to the single bundled
version. Independent step versioning is filed under [[Open-Questions]].

Path-like values (separators outside the single `<scope>/<name>`
slash), file extensions, whitespace, and empty pins are rejected.

## How factories use steps

```yaml
nodes:
  propose:
    uses: minifac:openspec-propose
    inputs:
      change: "{{ brief.change }}"
      brief_body: "{{ brief.body }}"
  apply:
    uses: minifac:openspec-apply
    inputs:
      change: "{{ brief.change }}"
  verify:
    uses: minifac:openspec-verify
    inputs:
      commands: ["npm test", "npm run build", "npm run check"]
  archive:
    uses: minifac:openspec-archive
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
