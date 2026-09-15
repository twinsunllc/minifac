## MODIFIED Requirements

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
  added to the accumulator **only when the same layer's `edges:`
  names the node as an endpoint** (`from` or `to`). A derived-layer
  node id that the accumulated base does not declare and that the
  layer's own `edges:` does not reference is an override of a node
  the base lacks — a typo, or a node the base renamed — and SHALL be
  a load error. The error SHALL name the override's node id, the
  base (its `extends:` reference and resolved path), and the base's
  declared node ids, and SHALL cite the derived layer's file. It
  SHALL NOT be added silently: with no inbound `on_success` edge it
  would be inferred as a start node and dispatched when the run
  begins.
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
  not present in the base, and the layer's `edges:` wires it
  (`propose → audit`, `audit → apply`)
- **THEN** the resolved factory's `nodes` map contains both the
  base's nodes and the new `audit` node

#### Scenario: Override naming a node the base lacks is a load error

- **WHEN** the loader reads a layer whose `extends:` names a base
  declaring `plan` and `verify`, and the layer's `nodes` map
  declares `veriy` (a typo for `verify`) with no `edges:`
- **THEN** the loader throws `FactoryLoadError` citing the derived
  layer's file, whose message names the node id `veriy`, the base's
  `extends:` reference and path, and the base's declared node ids
- **AND** the run does not start with `veriy` added as a start node

#### Scenario: A new node the layer's edges do not reference is rejected

- **WHEN** the loader reads a layer that declares an `audit` node not
  present in the base, and the layer declares `edges:` none of which
  names `audit`
- **THEN** the loader throws `FactoryLoadError` naming `audit` as an
  override of a node the base does not declare

#### Scenario: The check applies at every level of a chain

- **WHEN** the loader reads `top` extending `mid` extending
  `minifac:base`, and `top` declares an unwired node id that neither
  `mid` nor `minifac:base` declares
- **THEN** the loader throws `FactoryLoadError` naming the node id and
  `mid` as the base

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
