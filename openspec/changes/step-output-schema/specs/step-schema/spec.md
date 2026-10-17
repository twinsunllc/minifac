## MODIFIED Requirements

### Requirement: Step file format

A step SHALL be a single YAML document with snake_case keys at every level. The top-level object MUST contain a `name` (string), a `version` (string), an `executor` (string identifying a registered runner, e.g. `claude`), and a `with` (free-form object passed verbatim to the executor after `{{ inputs.* }}` substitution). The top-level object MAY contain a `description` (string), an `inputs` (mapping of input name → input definition; see "Step input schema" requirement), and an `outputs` (mapping of output key → output definition; see "Step-declared outputs" requirement).

The top-level object SHALL be strict on extras: any top-level key other than the documented set (`name`, `version`, `description`, `inputs`, `outputs`, `executor`, `with`) SHALL be rejected with an error naming the offending key.

`name` SHALL be a non-empty kebab-case identifier matching `[a-z][a-z0-9-]*`. `version` SHALL be a non-empty string. Step authors are expected to use SemVer-shaped strings (`MAJOR.MINOR.PATCH`), but the schema SHALL NOT validate the SemVer shape in v0; it only requires a non-empty string.

#### Scenario: Minimal valid step loads

- **WHEN** the loader reads a YAML file with `name: foo`, `version: "1.0.0"`, `executor: claude`, and `with: { prompt: "Say hello." }`
- **THEN** the loader returns a typed in-memory step object whose shape matches the schema and whose `inputs` is an empty mapping

#### Scenario: Missing `name` is rejected

- **WHEN** the loader reads a step YAML with no top-level `name` field
- **THEN** validation fails with an error identifying the missing field

#### Scenario: Missing `version` is rejected

- **WHEN** the loader reads a step YAML with no top-level `version` field
- **THEN** validation fails with an error identifying the missing field

#### Scenario: Missing `executor` is rejected

- **WHEN** the loader reads a step YAML with no top-level `executor` field
- **THEN** validation fails with an error identifying the missing field

#### Scenario: Missing `with` is rejected

- **WHEN** the loader reads a step YAML with no top-level `with` field
- **THEN** validation fails with an error identifying the missing field

#### Scenario: Unknown top-level key is rejected

- **WHEN** the loader reads a step YAML whose top-level declares a key not in the documented set (e.g. `runtime:`)
- **THEN** validation fails with an error naming the offending key

#### Scenario: Camel-case keys are rejected

- **WHEN** the loader reads a step YAML using `maxIterations` or `permissionMode` at any level whose schema declares the snake_case equivalent
- **THEN** validation fails with an error naming the offending key

#### Scenario: Non-string name is rejected

- **WHEN** the loader reads a step YAML whose `name:` is a number, boolean, list, or map
- **THEN** validation fails with an error identifying the `name` field's invalid type

#### Scenario: Empty `version` is rejected

- **WHEN** the loader reads a step YAML whose `version:` is the empty string
- **THEN** validation fails with an error identifying the `version` field

## ADDED Requirements

### Requirement: Step-declared outputs

A step MAY declare a top-level `outputs:` map. Its schema SHALL be the
same as a factory node's `outputs:` block (`factory-schema` "Node
`outputs:` block" and "`OutputDef` discriminated types"), including the
optional `schema:` on a `type: value` output. The loader SHALL validate
it when the step loads; an invalid entry, including an invalid JSON
Schema, SHALL be a `StepLoadError` whose `sourcePath` is the step file
and whose message names the offending path (e.g.
`outputs.result.schema`).

The step's `outputs:` is the default for every `uses:` node that does
not declare its own (`factory-schema` "Node `uses:` field as an
alternative to inline executor"). A step that declares no `outputs:`
contributes none.

#### Scenario: Step with a schema'd value output loads

- **WHEN** the loader reads a step declaring `outputs: { result: { type:
  value, required: true, schema: { type: object, required: [verdict],
  properties: { verdict: { enum: [pass, fail] } } } } }`
- **THEN** the step loads and `step.outputs.result.schema` deep-equals
  the declared schema

#### Scenario: Step with an invalid schema is refused naming the step file

- **WHEN** the loader reads a step whose `outputs.result.schema` is
  `{ type: strng }`, or declares an unknown keyword such as `requried`
- **THEN** loading fails with a `StepLoadError` whose `sourcePath` is the
  step file and whose message begins `Schema error at
  outputs.result.schema: invalid JSON Schema:`
