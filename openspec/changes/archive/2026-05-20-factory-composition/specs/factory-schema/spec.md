## ADDED Requirements

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
