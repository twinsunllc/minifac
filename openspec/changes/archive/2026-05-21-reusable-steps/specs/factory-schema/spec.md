## ADDED Requirements

### Requirement: Node `uses:` field as an alternative to inline executor

A factory node MAY declare a `uses:` field whose value SHALL be a non-empty string conforming to the `step-schema` capability's reference syntax (one of `minifac:<name>`, `<scope>/<name>[@<version>]`, or bare `<name>[@<version>]`). When a node declares `uses:`, it SHALL NOT also declare `executor:` or `with:` — the two patterns are mutually exclusive on a single node, and the loader SHALL reject a node that declares both.

A node with `uses:` MAY declare an `inputs:` field whose value SHALL be a flat object mapping input names (strings) to input values. The input values supply concrete values for the step's declared inputs; they are validated against the step's input schema at load time (see "Step input validation against the step's declared schema" requirement).

Node-level fields not specific to executor selection — `terminal`, `max_iterations`, `cwd`, and any future per-position fields — SHALL remain on the node regardless of whether the node uses inline `executor:` + `with:` or `uses:` + `inputs:`. These fields describe the node's position in the graph, not the step's behavior.

The factory schema SHALL remain strict on extras at the node level. The accepted node-level key set is: `executor`, `with`, `uses`, `inputs`, `terminal`, `max_iterations`, `cwd`. Any other key SHALL be rejected with an error naming the offending key and the node id.

#### Scenario: Node with `uses:` and no `inputs:` loads

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-propose` and no `inputs:` block, and the step's declared inputs all have defaults or are optional
- **THEN** the loader returns the factory with the node's `uses:` reference resolved and the step inlined; the node has `executor` and `with` after inlining and no `uses:` / `inputs:` fields on the resolved node

#### Scenario: Node with `uses:` and `inputs:` loads

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-propose` and an `inputs:` block mapping each of the step's required inputs to a value
- **THEN** the loader returns the factory with the node's step resolved and inlined; the node has `executor` and `with` after inlining and no `uses:` / `inputs:` fields on the resolved node

#### Scenario: Node with both `uses:` and `executor:` is rejected

- **WHEN** the loader reads a node that declares both `uses: minifac:foo` and `executor: claude`
- **THEN** validation fails with an error naming the node id and explaining the mutual-exclusion rule

#### Scenario: Node with both `uses:` and `with:` is rejected

- **WHEN** the loader reads a node that declares both `uses: minifac:foo` and `with: { permission_mode: "bypass_permissions" }`
- **THEN** validation fails with an error naming the node id and explaining the mutual-exclusion rule

#### Scenario: Node with `inputs:` but no `uses:` is rejected

- **WHEN** the loader reads a node that declares an `inputs:` block but no `uses:` field (and inline `executor:` + `with:` instead)
- **THEN** validation fails with an error naming the node id and explaining that `inputs:` is only valid alongside `uses:`

#### Scenario: Node with neither `uses:` nor `executor:` is rejected

- **WHEN** the loader reads a node that declares neither `uses:` nor `executor:`
- **THEN** validation fails with an error naming the node id and the missing-required-field

#### Scenario: Node with empty `uses:` string is rejected

- **WHEN** the loader reads a node whose `uses:` field is the empty string
- **THEN** validation fails with an error naming the node id and the `uses` field

#### Scenario: Node `uses:` of non-string type is rejected

- **WHEN** the loader reads a node whose `uses:` field is a list, map, number, or boolean
- **THEN** validation fails with an error naming the node id and the `uses` field's invalid type

#### Scenario: Node-level fields stay on node alongside `uses:`

- **WHEN** the loader reads a node that declares `uses: minifac:openspec-archive`, `terminal: true`, and `cwd: "{{ run.cwd }}"`
- **THEN** the resolved node carries `terminal: true` and `cwd: "{{ run.cwd }}"` after step inlining; these fields are not affected by the step's resolved body

#### Scenario: Unknown node-level key is still rejected

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and an unknown key like `retry:`
- **THEN** validation fails with an error naming the offending key and the node id

#### Scenario: Inline node without `uses:` continues to load unchanged

- **WHEN** the loader reads a factory whose nodes all declare inline `executor:` + `with:` (no `uses:` field anywhere)
- **THEN** the loader returns the factory with each node carrying `executor` and `with` exactly as declared; the loader performs no step resolution and the resolved factory is byte-equivalent to today's pre-change behavior

### Requirement: Step inlining order in the factory loader

The factory loader SHALL inline step references into flat node definitions during load. The inlining SHALL happen after `extends:` chain resolution (per the "Replace-at-node-level merge semantics" requirement) and before post-schema validation (start node, terminal node, cycle budgets, edge endpoints).

The resulting resolved factory SHALL contain only flat nodes (each with `executor` and `with`, plus any node-level fields the source declared). The runner SHALL NOT observe `uses:` or `inputs:` on any resolved node.

The inlining SHALL be a structural replacement: the step's `executor` value becomes the node's `executor`; the step's `with` object becomes the node's `with` (after `{{ inputs.* }}` substitution per the `graph-runner` capability's modified "Brief token substitution" requirement). The step's own `name`, `version`, `description`, and `inputs` declaration SHALL NOT appear on the resolved node.

If a node's `uses:` reference cannot be resolved (missing step file, malformed reference, etc.), the loader SHALL throw `FactoryLoadError` whose message names the factory entry-point file, the offending node id, and the underlying step resolution error (per the `step-schema` capability's "Step loader error reporting" requirement).

#### Scenario: Step inlining happens after extends resolution

- **WHEN** the loader reads `.minifac/factories/sdd-fast.yaml` whose `extends:` is `minifac:sdd`, and whose `nodes` map redeclares the `verify` node to `uses: minifac:openspec-verify-bun` (a hypothetical local step), and the base `minifac:sdd` declares the other three nodes via inline `executor:` + `with:`
- **THEN** the loader first resolves the extends chain (yielding a merged factory whose `verify` node carries `uses:`), then inlines step references on `verify`, then runs post-schema validation; the resolved factory has flat node bodies on all four nodes

#### Scenario: Step inlining runs before post-schema validation

- **WHEN** the loader reads a factory whose `uses:`-using node, after step inlining, makes the factory violate the terminal-node-required rule (e.g. inlining removes the only `terminal: true` declaration — though in practice `terminal` lives on the node, not the step)
- **THEN** post-schema validation runs against the resolved factory and reports the violation citing the entry-point file's `sourcePath`; step inlining itself does not fail

#### Scenario: Resolved factory has no `uses:` on any node

- **WHEN** the loader reads a factory where every node declares `uses:`, and the load completes successfully
- **THEN** the returned `Factory` object's nodes each have `executor` and `with` properties and SHALL NOT have a `uses` or `inputs` property; downstream consumers (runner, executor) cannot observe the step layer

#### Scenario: Missing step reference is rejected at load with a clear error

- **WHEN** the loader reads a factory whose node declares `uses: minifac:nonexistent-step` and no such step file exists
- **THEN** the loader throws `FactoryLoadError` whose message names the factory's `sourcePath`, the offending node id, and the underlying `StepLoadError` (which names the reference and the path(s) tried)

#### Scenario: Malformed `uses:` reference is rejected at load

- **WHEN** the loader reads a factory whose node declares `uses: "../foo.yaml"` (a path-like value rejected by the step reference grammar)
- **THEN** the loader throws `FactoryLoadError` whose message names the factory's `sourcePath`, the offending node id, and the step-reference validation failure

### Requirement: Step input validation against the step's declared schema

When a factory node declares `uses:`, the loader SHALL validate the node's `inputs:` block (or its absence) against the resolved step's declared input schema (per the `step-schema` capability's "Step input schema" requirement). The validation SHALL apply the following rules:

- **Missing required input.** For each input the step declares with `required: true`, the node's `inputs:` MUST supply a value. Absence SHALL be rejected with an error naming the factory entry-point file, the node id, the step's `sourcePath`, and the missing input key.
- **Type mismatch.** For each input the node supplies, the supplied value's type SHALL match the step's declared `type` for that input. Type matching SHALL be the structural JavaScript type (`typeof value === "string" | "number" | "boolean"`; arrays SHALL be `Array.isArray(value)`; objects SHALL be plain objects, not arrays, not null, and not other typed values). Mismatch SHALL be rejected with an error naming the factory, the node, the step, the input key, the declared type, and the supplied type.
- **Unknown input key.** Any key in the node's `inputs:` that does not appear in the step's declared input schema SHALL be rejected with an error naming the factory, the node, the step, and the offending key.
- **Default fill-in.** For each input the step declares with `required: false` and a `default`, if the node's `inputs:` does not supply a value for that key, the loader SHALL fill in the declared `default` before inlining. The default SHALL be inlined verbatim (no `{{ * }}` substitution on the default itself, since defaults are step-static and there are no namespaces in scope at the moment the default is resolved).
- **Templated input values.** A factory's input values MAY contain `{{ brief.* }}` or `{{ run.* }}` tokens. The loader SHALL NOT resolve those tokens at load time (the brief and run are not in scope at load). Instead, the tokens SHALL survive into the inlined step body verbatim, where they are resolved at dispatch time per the `graph-runner` capability's "Brief token substitution" requirement.

The validation SHALL happen immediately after step resolution and before step inlining. A validation failure SHALL prevent the inlining and surface as a `FactoryLoadError` per the "Step inlining order" requirement above.

#### Scenario: Missing required input is rejected

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-propose` and an `inputs:` block that omits the step's required `change` input
- **THEN** the loader throws `FactoryLoadError` whose message names the factory's `sourcePath`, the node id, the step's `sourcePath`, and the missing `change` input

#### Scenario: Type mismatch is rejected

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-verify` and an `inputs:` block supplying `commands: "npm test"` where the step declares `commands: { type: "array" }`
- **THEN** the loader throws `FactoryLoadError` whose message names the factory, the node, the step, the offending input key (`commands`), the declared type (`array`), and the supplied type (`string`)

#### Scenario: Unknown input key is rejected

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-propose` and an `inputs:` block supplying `weather: "sunny"` where the step's input schema declares no `weather` input
- **THEN** the loader throws `FactoryLoadError` whose message names the factory, the node, the step, and the unknown `weather` key

#### Scenario: Optional input with default fills in when omitted

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-verify` and omits the step's optional `commands` input, and the step declares `commands: { type: "array", default: ["npm test"] }`
- **THEN** the resolved node's inlined `with` block has `commands` resolved as `["npm test"]` wherever the step body references it

#### Scenario: Optional input with default but no node supply is accepted

- **WHEN** the loader reads a factory whose node declares `uses: minifac:foo` and no `inputs:` block at all, and every input the step declares is either optional (with a default) or not used in the step's `with:` body
- **THEN** the loader successfully resolves and inlines the step with defaults applied; no error is raised

#### Scenario: Optional input without default and no node supply is accepted

- **WHEN** the loader reads a factory whose node declares `uses: minifac:foo`, the step declares an input `model: { type: "string" }` (optional, no default), and the node omits `model`
- **THEN** the loader successfully resolves the reference; `{{ inputs.model }}` references in the step's body resolve to the empty string at dispatch time per the runner's templating rules

#### Scenario: Templated input value survives load

- **WHEN** the loader reads a factory whose node declares `inputs: { change: "{{ brief.change }}" }` (the value is a brief token, not a literal)
- **THEN** the loader treats `"{{ brief.change }}"` as a string (passing the step's `type: "string"` check) and inlines it verbatim into the step's `with` block; the `{{ brief.change }}` token is resolved at dispatch time by the runner

#### Scenario: Boolean input value is type-checked

- **WHEN** the loader reads a factory whose node declares `inputs: { dry_run: true }` and the step declares `dry_run: { type: "boolean" }`
- **THEN** the loader passes the type check (`typeof true === "boolean"`) and inlines the value; `{{ inputs.dry_run }}` in the step's prompt resolves to the string `"true"` at dispatch time

#### Scenario: Array input value is type-checked

- **WHEN** the loader reads a factory whose node declares `inputs: { commands: ["npm test", "npm run build"] }` and the step declares `commands: { type: "array" }`
- **THEN** the loader passes the type check (`Array.isArray(value) === true`) and inlines the value

#### Scenario: Object input value is type-checked

- **WHEN** the loader reads a factory whose node declares `inputs: { config: { mode: "fast" } }` and the step declares `config: { type: "object" }`
- **THEN** the loader passes the type check (plain object, not array, not null) and inlines the value

#### Scenario: Null is not a valid object input

- **WHEN** the loader reads a factory whose node declares `inputs: { config: null }` and the step declares `config: { type: "object" }`
- **THEN** the loader rejects the value as a type mismatch (null is not a plain object)
