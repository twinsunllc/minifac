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

The factory schema SHALL reserve the token shape `{{ brief.<field> }}`
inside node `with.prompt` strings for runtime substitution by the
`graph-runner` capability. The schema SHALL NOT enforce whether tokens
are present or which fields they reference; substitution is the
`graph-runner` capability's responsibility (see that spec's "Brief
token substitution" requirement). Factory authors SHALL NOT rely on a
token of that shape passing through to the executor as a literal
string unless the factory declares `brief: "none"` and is therefore
guaranteed never to have a brief in scope.

The reserved field set is `change | body | factory | base_branch |
model`. Other identifiers inside `{{ brief.* }}` braces are reserved
for future fields; today they pass through verbatim per the runner's
substitution rules.

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

