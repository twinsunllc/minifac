## MODIFIED Requirements

### Requirement: Node `uses:` field as an alternative to inline executor

A factory node MAY declare a `uses:` field whose value SHALL be a non-empty string conforming to the `step-schema` capability's reference syntax (one of `minifac:<name>`, `<scope>/<name>[@<version>]`, or bare `<name>[@<version>]`). When a node declares `uses:`, it SHALL NOT also declare `executor:` — the two patterns are mutually exclusive on a single node, and the loader SHALL reject a node that declares both. A node that declares `uses:` MAY also declare a `with:` whose only key is `secrets`, whose value SHALL be a list. The loader SHALL copy that list, unchanged and in order, into the inlined step's `with` as `with.secrets`. Beside `uses:`, the loader SHALL reject, with a `FactoryLoadError` whose message is one sentence naming the node id: a `with:` holding any key other than `secrets` (alone or beside `secrets`); an empty `with: {}`; a `with:` that is not a mapping; and a `with.secrets` that is not a list. When the node declares `with.secrets` and the step's own `with` already declares `secrets`, the loader SHALL reject the node with a one-sentence `FactoryLoadError` naming the node id and the step, whether or not the two lists are equal; it SHALL NOT override or union them. The loader SHALL NOT validate the list's entries; their shape belongs to the consumer that reads `with.secrets`, as it does for an inline node.

A node with `uses:` MAY declare an `inputs:` field whose value SHALL be a flat object mapping input names (strings) to input values. The input values supply concrete values for the step's declared inputs; they are validated against the step's input schema at load time (see "Step input validation against the step's declared schema" requirement).

Node-level fields not specific to executor selection — `terminal`, `max_iterations`, `cwd`, `outputs`, `output_nudge_budget`, `resume`, and any future per-position fields — SHALL remain on the node regardless of whether the node uses inline `executor:` + `with:` or `uses:` + `inputs:`. These fields describe the node's position in the graph, not the step's behavior.

The factory schema SHALL remain strict on extras at the node level. The accepted node-level key set is: `executor`, `with`, `uses`, `inputs`, `terminal`, `max_iterations`, `cwd`, `outputs`, `output_nudge_budget`, `resume`. Any other key SHALL be rejected with an error naming the offending key and the node id.

#### Scenario: Node with `uses:` and no `inputs:` loads

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-propose` and no `inputs:` block, and the step's declared inputs all have defaults or are optional
- **THEN** the loader returns the factory with the node's `uses:` reference resolved and the step inlined; the node has `executor` and `with` after inlining and no `uses:` / `inputs:` fields on the resolved node

#### Scenario: Node with `uses:` and `inputs:` loads

- **WHEN** the loader reads a factory whose node declares `uses: minifac:openspec-propose` and an `inputs:` block mapping each of the step's required inputs to a value
- **THEN** the loader returns the factory with the node's step resolved and inlined; the node has `executor` and `with` after inlining and no `uses:` / `inputs:` fields on the resolved node

#### Scenario: Node with both `uses:` and `executor:` is rejected

- **WHEN** the loader reads a node that declares both `uses: minifac:foo` and `executor: claude`
- **THEN** validation fails with an error naming the node id and explaining the mutual-exclusion rule

#### Scenario: Node with `uses:` and a `with:` key other than `secrets` is rejected

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and `with: { permission_mode: "bypass_permissions" }`, or `with: { prompt: "y" }`, or `with: { secrets: [A], model: "z" }`
- **THEN** validation fails with a one-sentence `FactoryLoadError` naming the node id, the offending key, and the mutual-exclusion rule

#### Scenario: Node with `uses:` and `with: { secrets }` loads with the list merged (local step)

- **WHEN** the loader reads a node that declares `uses: <local step>` and `with: { secrets: [A, { name: B, via: proxy }] }`, and the step's `with` declares no `secrets`
- **THEN** the resolved node's `with.secrets` deep-equals `[A, { name: B, via: proxy }]`, the step's other `with` keys are unchanged, and the resolved node has no `uses:` / `inputs:` fields

#### Scenario: Node with `uses:` and `with: { secrets }` loads with the list merged (library step)

- **WHEN** the loader reads, in a project that pins a library, a node that declares `uses: <library step>` and `with: { secrets: [...] }`
- **THEN** the resolved node's `with.secrets` deep-equals the declared list and the library step's other `with` keys are unchanged

#### Scenario: Node `with.secrets` refused when the step already declares `secrets`

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and `with: { secrets: [A] }`, and step `foo`'s own `with` declares `secrets` (equal to `[A]` or not)
- **THEN** validation fails with a one-sentence `FactoryLoadError` naming the node id and the step; nothing is overridden or unioned

#### Scenario: Malformed `with:` beside `uses:` is rejected

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and `with: {}`, or `with: { secrets: "A" }`, or a `with:` that is not a mapping
- **THEN** validation fails with an error naming the node id

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

#### Scenario: `resume:` stays on the node alongside `uses:`

- **WHEN** the loader reads a node that declares `uses: minifac:openspec-apply` and `resume: propose`
- **THEN** the resolved node carries `resume: "propose"` after step inlining; the inlined step body is byte-identical to the body the same step produces for a node that declares no `resume:`

#### Scenario: Unknown node-level key is still rejected

- **WHEN** the loader reads a node that declares `uses: minifac:foo` and an unknown key like `retry:`
- **THEN** validation fails with an error naming the offending key and the node id

#### Scenario: Inline node without `uses:` continues to load unchanged

- **WHEN** the loader reads a factory whose nodes all declare inline `executor:` + `with:` (no `uses:` field anywhere)
- **THEN** the loader returns the factory with each node carrying `executor` and `with` exactly as declared; the loader performs no step resolution and the resolved factory is byte-equivalent to today's pre-change behavior
