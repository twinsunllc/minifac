## ADDED Requirements

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
