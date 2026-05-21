# factory-schema Specification

## Purpose
TBD - created by archiving change core-graph-runner. Update Purpose after archive.
## Requirements
### Requirement: Factory file format

A factory SHALL be a single YAML document with snake_case keys at every
level. The top-level object MUST contain a `name` (string), a `nodes`
mapping (id → node definition), and an `edges` array. It MAY contain a
`description` (string).

#### Scenario: Minimal valid factory loads

- **WHEN** the loader reads a YAML file with `name`, a `nodes` map
  containing at least one node, and an `edges` array (possibly empty)
- **THEN** the loader returns a typed in-memory factory object whose
  shape matches the schema

#### Scenario: Camel-case keys are rejected

- **WHEN** the loader reads a YAML file using `maxIterations` instead of
  `max_iterations`
- **THEN** validation fails with an error naming the offending key and
  its source location

### Requirement: Node definition

Each node SHALL declare an `executor` (string identifying a registered
runner, e.g. `claude`). It MAY declare `terminal` (boolean, default
`false`), `max_iterations` (positive integer), `cwd` (string), and
`with` (free-form object passed verbatim to the executor).

#### Scenario: Node without executor fails validation

- **WHEN** a node definition is missing the `executor` key
- **THEN** validation fails with an error identifying the node id and the
  missing field

#### Scenario: Unknown top-level node keys are rejected

- **WHEN** a node defines a key not in the schema envelope (e.g. `retry`)
- **THEN** validation fails. (Executor-specific keys belong under `with:`.)

#### Scenario: `with:` is opaque to the schema

- **WHEN** a node declares `with: { prompt: "hello" }`
- **THEN** the schema accepts the node regardless of `with` contents;
  per-executor validation of `with` happens inside the executor

### Requirement: Edge definition

Each edge SHALL declare `from` (node id) and `to` (node id), both of which
MUST reference declared nodes. An edge MAY declare `max_traversals`
(positive integer) and `when` (a string condition; semantics are
runner-defined — for v0, only the literal `"on_failure"` and `"on_success"`
are recognized, defaulting to `"on_success"`).

#### Scenario: Edge to undeclared node fails validation

- **WHEN** an edge references a `to` id that is not in the `nodes` map
- **THEN** validation fails with an error naming the missing id and the
  edge's source location

#### Scenario: Unknown `when` value is rejected

- **WHEN** an edge declares `when: "on_weekend"`
- **THEN** validation fails with an error listing the supported values

### Requirement: Cycle budgets are mandatory

If the graph contains any cycle, every cycle SHALL be covered by at least
one budget — either a `max_traversals` on an edge in the cycle, or a
`max_iterations` on a node in the cycle. The loader SHALL refuse a
factory containing an uncovered cycle.

#### Scenario: Unbounded cycle is rejected

- **WHEN** the loader reads a factory whose graph contains nodes A → B → A
  with no `max_traversals` on either edge and no `max_iterations` on
  either node
- **THEN** validation fails with an error identifying the cycle and the
  missing budget

#### Scenario: Cycle covered by an edge budget is accepted

- **WHEN** the loader reads a factory whose graph contains nodes A → B → A
  where the B → A edge has `max_traversals: 3`
- **THEN** validation succeeds

### Requirement: Terminal node is required

A valid factory SHALL contain at least one node with `terminal: true`.
The loader SHALL reject factories with no terminal node.

#### Scenario: Factory without terminal node is rejected

- **WHEN** the loader reads a factory in which no node has
  `terminal: true`
- **THEN** validation fails with an error explaining that a terminal
  node is required

### Requirement: Error reporting includes source location

When validation fails, the loader SHALL surface the offending YAML
source location (line and column when available) alongside the error
message.

#### Scenario: Malformed YAML reports a line number

- **WHEN** the loader reads a YAML file with a syntax error on line 7
- **THEN** the error message includes line 7 (and column when available)

### Requirement: Factory brief-mode declaration

A factory MAY declare a top-level `brief:` field whose value SHALL be
one of the literal strings `"required"`, `"optional"`, or `"none"`.
When omitted, the field SHALL default to `"required"`. The field
controls whether and how the factory consumes a brief at run time
(enforced by the `run-cli` capability); the schema's responsibility is
strict literal validation.

Strict-on-extras still applies at the factory top-level: a top-level
key other than the documented set (`name`, `description`, `brief`,
`nodes`, `edges`) SHALL be rejected.

#### Scenario: Omitted brief field defaults to required

- **WHEN** the loader reads a factory YAML whose top-level object
  declares `name`, `nodes`, `edges` but no `brief:` field
- **THEN** the returned factory object has `brief === "required"`

#### Scenario: Explicit `brief: optional` parses

- **WHEN** the loader reads a factory YAML whose top-level declares
  `brief: optional`
- **THEN** the returned factory object has `brief === "optional"`,
  with no error

#### Scenario: Explicit `brief: none` parses

- **WHEN** the loader reads a factory YAML whose top-level declares
  `brief: none`
- **THEN** the returned factory object has `brief === "none"`, with
  no error

#### Scenario: Unknown brief literal is rejected

- **WHEN** the loader reads a factory YAML whose top-level declares
  `brief: yolo`
- **THEN** validation fails with an error naming the offending value
  and listing the supported literals

### Requirement: Reserved brief template tokens in node prompts

The factory schema SHALL reserve the token shape
`{{ <ns>.<field> }}` inside both node `with.prompt` strings AND
node `cwd` strings for runtime substitution by the `graph-runner`
capability. The recognized namespaces are `brief` and `run`. The
schema SHALL NOT enforce whether tokens are present or which
fields they reference; substitution is the `graph-runner`
capability's responsibility (see that spec's "Brief token
substitution" requirement). Factory authors SHALL NOT rely on a
token of either shape passing through to the executor as a literal
string unless the factory declares `brief: "none"` (for
`{{ brief.* }}`) AND the run does not supply a `runCwd` (for
`{{ run.* }}`).

The reserved field sets are:

- `brief.<field>` where `<field>` is one of `change | body |
  factory | base_branch | model`. Other identifiers under the
  `brief` namespace are reserved for future fields; today they
  pass through verbatim per the runner's substitution rules.
- `run.<field>` where `<field>` is `cwd`. Other identifiers under
  the `run` namespace are reserved for future fields; today they
  pass through verbatim per the runner's substitution rules.

The set of fields a factory author is permitted to template SHALL
NOT differ between `with.prompt` and `cwd` — both accept any
token in the reserved grammar. The substitution semantics
(including the empty-string default for absent optional brief
fields and the leave-verbatim default for unknown identifiers)
are identical across both target fields, per the `graph-runner`
spec.

#### Scenario: Prompts with template tokens load without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `with.prompt: "Work on {{ brief.change }}.\n\n{{ brief.body }}"`
- **THEN** the loader returns a typed factory object without error;
  the prompt string is preserved verbatim with tokens intact

#### Scenario: Prompts without template tokens are unaffected

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `with.prompt: "Say hello in one sentence."`
- **THEN** the loader returns a typed factory object without error;
  the prompt string is preserved verbatim

#### Scenario: cwd with `{{ run.cwd }}` loads without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `cwd: "{{ run.cwd }}"`
- **THEN** the loader returns a typed factory object without error;
  the `cwd` string is preserved verbatim with the token intact

#### Scenario: cwd with `{{ brief.change }}` loads without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `cwd: "/repos/{{ brief.change }}"`
- **THEN** the loader returns a typed factory object without error;
  the `cwd` string is preserved verbatim with the token intact

#### Scenario: Literal cwd is unaffected

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `cwd: "/explicit/path"`
- **THEN** the loader returns a typed factory object without error;
  the `cwd` string is preserved verbatim with no token in it

### Requirement: Factory `extends:` top-level field

The factory schema SHALL accept an optional top-level `extends:` field whose value, when present, MUST be a single non-empty string identifying a base factory to extend. The string SHALL be one of:

- `minifac:<built-in-name>` — a reference to a built-in factory. For
  v0 this resolves to `<caller-cwd>/examples/<built-in-name>.yaml`.
- `<local-name>` (no prefix) — a reference to another local custom
  factory at `<caller-cwd>/.minifac/factories/<local-name>.yaml`.
  Local references MAY themselves declare an `extends:` field
  (recursive extension).

When the loader reads a factory file with `extends:` set, it SHALL
resolve the chain into a single in-memory factory before running any
schema-level or post-schema validation. A factory file without
`extends:` SHALL be loaded as-is, preserving today's single-file
behavior.

The `extends:` key SHALL be valid as a top-level key alongside the
existing documented keys (`name`, `description`, `brief`, `nodes`,
`edges`). The factory schema's strict-on-extras rule SHALL continue
to reject any other unknown top-level key.

#### Scenario: Factory without `extends:` loads as before

- **WHEN** the loader reads a factory YAML with no `extends:` field
- **THEN** the loader's behavior is identical to today: the file
  loads as a single factory, validated in isolation

#### Scenario: `extends:` with empty string is rejected

- **WHEN** the loader reads a factory YAML whose `extends:` field is
  an empty string
- **THEN** schema validation fails with an error identifying the
  `extends` field

#### Scenario: `extends:` of a non-string value is rejected

- **WHEN** the loader reads a factory YAML whose `extends:` field is
  a list, map, number, or boolean
- **THEN** schema validation fails with an error identifying the
  `extends` field's invalid type

#### Scenario: Unknown top-level key remains rejected

- **WHEN** the loader reads a factory YAML whose top-level declares
  a key not in the documented set (`name`, `description`, `brief`,
  `nodes`, `edges`, `extends`) — e.g. `inherits:`
- **THEN** schema validation fails with an error naming the
  offending key

### Requirement: `extends:` chain resolution rules

When a factory declares `extends:`, the loader SHALL resolve the
reference using the following rules, evaluated relative to the cwd
the loader is given (the calling repo root):

- A `minifac:<name>` reference SHALL resolve to
  `<cwd>/examples/<name>.yaml`. If that path does not exist, the
  loader SHALL throw `FactoryLoadError` naming both the reference
  and the path tried.
- A `<name>` reference (no prefix) SHALL resolve to
  `<cwd>/.minifac/factories/<name>.yaml`. If that path does not
  exist, the loader SHALL throw `FactoryLoadError` naming both the
  reference and the path tried.
- A reference whose value contains a path separator or extension
  (e.g. `extends: ../factories/foo.yaml`) SHALL be rejected with a
  `FactoryLoadError` naming the offending value; only `minifac:<name>`
  and bare `<name>` are valid forms in v0.

The loader SHALL detect cycles in the `extends:` chain. If the same
absolute factory path is visited twice while walking
`extends:`, the loader SHALL throw `FactoryLoadError` naming the
cycle (the sequence of files involved) and the file whose `extends:`
closed the loop.

The loader SHALL surface resolution errors with the same
`FactoryLoadError` shape used elsewhere — including the
`sourcePath` of the file where the failing `extends:` was declared,
so the operator knows which file to edit.

#### Scenario: `minifac:<name>` resolves to examples/<name>.yaml

- **WHEN** the loader reads `.minifac/factories/sdd.yaml` whose
  `extends:` field is `minifac:sdd`, and `<cwd>/examples/sdd.yaml`
  exists and is a valid factory
- **THEN** the loader resolves the base to `<cwd>/examples/sdd.yaml`
  and proceeds to merge layers without error

#### Scenario: Bare `<name>` resolves to .minifac/factories/<name>.yaml

- **WHEN** the loader reads `.minifac/factories/sdd-fast.yaml` whose
  `extends:` field is `sdd`, and
  `<cwd>/.minifac/factories/sdd.yaml` exists and is a valid factory
- **THEN** the loader resolves the base to
  `<cwd>/.minifac/factories/sdd.yaml` and proceeds to merge layers
  without error

#### Scenario: Missing base file is rejected at load time

- **WHEN** the loader reads `.minifac/factories/sdd.yaml` whose
  `extends:` is `minifac:sdd` and `<cwd>/examples/sdd.yaml` does
  not exist
- **THEN** the loader throws `FactoryLoadError` whose message names
  both `minifac:sdd` and the absolute path it tried, and whose
  `sourcePath` is `.minifac/factories/sdd.yaml`

#### Scenario: Missing local base file is rejected at load time

- **WHEN** the loader reads `.minifac/factories/sdd-fast.yaml`
  whose `extends:` is `sdd-base` and
  `<cwd>/.minifac/factories/sdd-base.yaml` does not exist
- **THEN** the loader throws `FactoryLoadError` whose message names
  both `sdd-base` and the absolute path it tried, and whose
  `sourcePath` is `.minifac/factories/sdd-fast.yaml`

#### Scenario: Cyclic extends chain is rejected at load time

- **WHEN** the loader reads `.minifac/factories/a.yaml` whose
  `extends:` is `b`, and `.minifac/factories/b.yaml`'s `extends:`
  is `a`
- **THEN** the loader throws `FactoryLoadError` whose message names
  the cycle (paths `a.yaml → b.yaml → a.yaml`) and identifies the
  edge that closed the loop

#### Scenario: Self-referential extends is rejected

- **WHEN** the loader reads `.minifac/factories/a.yaml` whose
  `extends:` field is `a` (so the file extends itself)
- **THEN** the loader throws `FactoryLoadError` naming the
  self-cycle and the file path

#### Scenario: `extends:` with a path-like value is rejected

- **WHEN** the loader reads a factory whose `extends:` field is
  `../other/foo.yaml` or `./foo`
- **THEN** the loader throws `FactoryLoadError` naming the
  offending value and explaining that only `minifac:<name>` and
  bare `<name>` forms are accepted

### Requirement: Replace-at-node-level merge semantics

The loader SHALL merge an `extends:` chain into a single in-memory factory by applying layers in deepest-base-first order using **replace-at-node-level** semantics, defined as follows:

- **Nodes.** For every node id declared in the derived layer's
  `nodes` map, the accumulator's node at that id SHALL be replaced
  in full by the derived layer's definition. No field-level merging
  occurs: if a derived layer redeclares `verify`, the entire
  `verify` node from the base is replaced, and any field present
  only in the base (e.g. `cwd`, `with.allowed_tools`) is lost
  unless redeclared.
- Nodes whose ids appear in the base but not in the derived layer
  SHALL be preserved unchanged.
- New nodes (ids that appear only in the derived layer) SHALL be
  added to the accumulator.
- **Edges.** If the derived layer declares an `edges:` array (even
  an empty array), the accumulator's `edges` SHALL be replaced
  wholesale by the derived layer's array. If the derived layer
  omits `edges:`, the base's edges SHALL be preserved unchanged.
- **Top-level scalar fields.** `name`, `description`, and `brief`
  SHALL be overridden if the derived layer declares them; else
  inherited from the base.

Validation (schema, start-node, terminal-node, cycle-budget,
edge-endpoint) SHALL run against the resolved factory, not against
any individual layer. The `extends:` field itself SHALL be stripped
from the resolved factory; downstream consumers SHALL NOT see it.

#### Scenario: Override replaces a single node and preserves the rest

- **WHEN** the loader reads `.minifac/factories/sdd.yaml` whose
  `extends:` is `minifac:sdd` and whose `nodes` map redeclares
  only `verify`, and the base `minifac:sdd` defines `propose`,
  `apply`, `verify`, `archive`
- **THEN** the resolved factory contains four nodes (`propose`,
  `apply`, `verify`, `archive`); the `verify` node matches the
  override exactly; the other three nodes match the base exactly;
  the base's `verify` (including its `with:` payload) is not
  merged with the override

#### Scenario: Override adds a new node

- **WHEN** the loader reads a layer that declares an `audit` node
  not present in the base
- **THEN** the resolved factory's `nodes` map contains both the
  base's nodes and the new `audit` node

#### Scenario: `edges:` in derived layer replaces base edges wholesale

- **WHEN** the loader reads a layer whose `edges:` is `[{from:
  propose, to: apply}]` and the base's `edges` contains five edges
  including `propose → apply`
- **THEN** the resolved factory's `edges` array has one element:
  the layer's `propose → apply` edge; none of the base's other
  edges are retained

#### Scenario: Layer omitting `edges:` inherits base edges

- **WHEN** the loader reads a layer with no `edges:` field and a
  base whose `edges` contains five edges
- **THEN** the resolved factory's `edges` array is the base's
  five edges unchanged

#### Scenario: Empty `edges:` array in derived layer is meaningful

- **WHEN** the loader reads a layer whose `edges:` is an empty
  array `[]` and a base with three edges
- **THEN** the resolved factory's `edges` array is empty (and
  post-schema validation will reject it for whatever downstream
  reason — start-node, terminal, etc. — without the loader having
  treated empty as omitted)

#### Scenario: Top-level `name`, `description`, `brief` are overridden when declared

- **WHEN** the loader reads a layer that declares `name: sdd-fast`,
  `description: Fast variant`, and `brief: optional`, with a base
  declaring `name: sdd`, `description: Canonical SDD loop`,
  `brief: required`
- **THEN** the resolved factory has `name: sdd-fast`,
  `description: Fast variant`, `brief: optional`

#### Scenario: Top-level fields omitted in layer are inherited

- **WHEN** the loader reads a layer that omits `name`,
  `description`, and `brief`, with a base declaring all three
- **THEN** the resolved factory's `name`, `description`, and
  `brief` match the base verbatim

#### Scenario: Resolved factory drops `extends:`

- **WHEN** the loader reads a factory with `extends:` set and
  successfully resolves it
- **THEN** the returned `Factory` object has no `extends` property;
  downstream consumers cannot observe the chain

#### Scenario: Post-schema validation runs against the resolved factory

- **WHEN** the loader reads a layer whose override removes
  `terminal: true` from the only terminal node in the base, leaving
  no terminal node in the resolved factory
- **THEN** validation fails with the same "factory has no terminal
  node" error today's loader gives, citing the entry-point file's
  `sourcePath`

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

