## ADDED Requirements

### Requirement: Step file format

A step SHALL be a single YAML document with snake_case keys at every level. The top-level object MUST contain a `name` (string), a `version` (string), an `executor` (string identifying a registered runner, e.g. `claude`), and a `with` (free-form object passed verbatim to the executor after `{{ inputs.* }}` substitution). The top-level object MAY contain a `description` (string) and an `inputs` (mapping of input name → input definition; see "Step input schema" requirement).

The top-level object SHALL be strict on extras: any top-level key other than the documented set (`name`, `version`, `description`, `inputs`, `executor`, `with`) SHALL be rejected with an error naming the offending key.

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

### Requirement: Step input schema

A step's `inputs:` field, when present, SHALL be a mapping of input name → input definition. Each input name MUST match `[a-zA-Z_][a-zA-Z0-9_]*`. Each input definition SHALL be an object with these fields:

- `type` (required): one of the literal strings `"string"`, `"number"`, `"boolean"`, `"array"`, `"object"`.
- `required` (optional, default `false`): boolean.
- `default` (optional): a value of the declared `type`. Present only when `required` is `false` (or absent). When present, its type SHALL match the declared `type` (e.g. an input with `type: number` and `default: "hi"` is rejected).
- `description` (optional): string.

The input definition SHALL be strict on extras: any key other than `type`, `required`, `default`, `description` SHALL be rejected.

An input with `required: true` MUST NOT declare a `default` — the loader SHALL reject such a definition with an error explaining the conflict.

#### Scenario: Minimal input definition loads

- **WHEN** the loader reads a step whose `inputs:` declares `change: { type: "string", required: true }`
- **THEN** the loader returns the step with `inputs.change` shaped as `{ type: "string", required: true }` and no `default`

#### Scenario: Default of wrong type is rejected

- **WHEN** the loader reads a step whose `inputs:` declares `count: { type: "number", default: "three" }`
- **THEN** validation fails with an error naming the `count` input and the type mismatch between the declared `type` and the `default` value

#### Scenario: Boolean default loads

- **WHEN** the loader reads a step whose `inputs:` declares `dry_run: { type: "boolean", default: false }`
- **THEN** the loader returns the step with `inputs.dry_run` shaped as `{ type: "boolean", required: false, default: false }`

#### Scenario: Array default loads

- **WHEN** the loader reads a step whose `inputs:` declares `commands: { type: "array", default: ["npm test"] }`
- **THEN** the loader returns the step with `inputs.commands` shaped as `{ type: "array", required: false, default: ["npm test"] }`

#### Scenario: Unknown type literal is rejected

- **WHEN** the loader reads a step whose `inputs:` declares `flag: { type: "bool" }` (instead of `"boolean"`)
- **THEN** validation fails with an error naming the offending value and listing the supported literals

#### Scenario: Missing `type` is rejected

- **WHEN** the loader reads a step whose `inputs:` declares an input with no `type` field
- **THEN** validation fails with an error naming the offending input and the missing field

#### Scenario: Unknown key inside input definition is rejected

- **WHEN** the loader reads a step whose `inputs:` declares `change: { type: "string", validator: "regex:..." }`
- **THEN** validation fails with an error naming the offending key

#### Scenario: Invalid input name is rejected

- **WHEN** the loader reads a step whose `inputs:` declares an input named `1st-arg` (starts with a digit / contains a hyphen)
- **THEN** validation fails with an error naming the offending input name

#### Scenario: Required input with default is rejected

- **WHEN** the loader reads a step whose `inputs:` declares `change: { type: "string", required: true, default: "foo" }`
- **THEN** validation fails with an error explaining that a required input MUST NOT declare a default

### Requirement: Step reference syntax and lookup precedence

The reference grammar SHALL accept three forms. In all forms, `<name>` matches `[a-z][a-z0-9-]*` and `<version>`, when present, matches a non-empty string after `@`:

- `minifac:<name>` (built-in prefix) — SHALL skip the local lookup and resolve directly to `<caller-cwd>/examples/steps/<name>.yaml`.
- `<scope>/<name>` or `<scope>/<name>@<version>` — namespaced reference. The `<scope>` SHALL match `[a-z][a-z0-9-]*`. The version, when present, SHALL be parsed but in v0 SHALL be ignored for resolution (every reference resolves to the single shipped version). For v0 the lookup follows the bare-name two-step precedence below (local first, then built-in); the `<scope>/` prefix carries no runtime semantics in v0 beyond being preserved in error messages.
- `<name>` or `<name>@<version>` (bare) — SHALL try `<caller-cwd>/.minifac/steps/<name>.yaml` first; if that path does not exist, fall back to `<caller-cwd>/examples/steps/<name>.yaml`.

A reference whose value contains a path separator (other than the single `<scope>/<name>` separator), a file extension, or whitespace SHALL be rejected with a `StepLoadError` naming the offending value; only the three forms above are valid in v0.

Resolution SHALL be evaluated relative to the cwd the factory loader is given. The resolver SHALL return the absolute path of the resolved file; downstream code reads and parses that file.

On a missed lookup (no candidate path exists), the resolver SHALL throw `StepLoadError` whose message names the reference and every path tried, in order, so the operator can correct the typo or add the missing step.

The `minifac/<name>` shape (with a `/`) is a `<scope>/<name>` reference and follows local-first lookup; the `minifac:<name>` shape (with a `:`) is the built-in-prefix form and skips local lookup. Authors who want built-in-only resolution SHALL use the `:` form.

#### Scenario: `minifac:<name>` resolves to examples/steps/<name>.yaml

- **WHEN** the resolver is asked to resolve `minifac:openspec-propose` and `<cwd>/examples/steps/openspec-propose.yaml` exists
- **THEN** the resolver returns the absolute path to that file and does not try the local path

#### Scenario: `minifac:<name>` skips local lookup even if local exists

- **WHEN** the resolver is asked to resolve `minifac:openspec-propose`, both `<cwd>/.minifac/steps/openspec-propose.yaml` and `<cwd>/examples/steps/openspec-propose.yaml` exist
- **THEN** the resolver returns the path to the built-in file in `examples/steps/`; the local file is not consulted

#### Scenario: Bare `<name>` prefers local over built-in

- **WHEN** the resolver is asked to resolve `openspec-verify`, and both `<cwd>/.minifac/steps/openspec-verify.yaml` and `<cwd>/examples/steps/openspec-verify.yaml` exist
- **THEN** the resolver returns the path to the local file in `.minifac/steps/`

#### Scenario: Bare `<name>` falls back to built-in when local is missing

- **WHEN** the resolver is asked to resolve `openspec-verify` and only `<cwd>/examples/steps/openspec-verify.yaml` exists (no local file)
- **THEN** the resolver returns the path to the built-in file

#### Scenario: Missing bare reference is rejected with both paths tried

- **WHEN** the resolver is asked to resolve `nonexistent` and neither `<cwd>/.minifac/steps/nonexistent.yaml` nor `<cwd>/examples/steps/nonexistent.yaml` exists
- **THEN** the resolver throws `StepLoadError` whose message names the reference and both candidate absolute paths in order

#### Scenario: Missing `minifac:<name>` is rejected with the one path tried

- **WHEN** the resolver is asked to resolve `minifac:nonexistent` and `<cwd>/examples/steps/nonexistent.yaml` does not exist
- **THEN** the resolver throws `StepLoadError` whose message names the reference and the single built-in path tried

#### Scenario: Path-like reference is rejected

- **WHEN** the resolver is asked to resolve `./steps/foo.yaml` or `../steps/foo`
- **THEN** the resolver throws `StepLoadError` naming the offending value and explaining that only the documented forms are accepted

#### Scenario: Reference with whitespace is rejected

- **WHEN** the resolver is asked to resolve `open spec verify`
- **THEN** the resolver throws `StepLoadError` naming the offending value

### Requirement: Step version pinning is parsed but ignored in v0

A reference MAY carry a trailing `@<version>` pin. The pin SHALL be parsed off the reference for diagnostic purposes (the resolver SHALL preserve the pin in error messages and surface it from any introspection API like `minifac steps`) but SHALL NOT affect path resolution in v0. Every resolved reference SHALL load the single shipped step at the resolved path regardless of the pin.

Pin grammar: literal `@`, followed by a non-empty string. The common shapes — `@1`, `@1.0`, `@1.0.0` — are documented in `docs/concepts/Step.md`; the schema SHALL NOT validate the inner shape in v0.

When the resolved step's `version:` field does not satisfy the pin (by any user-supplied predicate), the loader SHALL NOT reject the reference in v0. Version-pin enforcement is deferred per ADR 0018 (tool-version-locked) and `docs/Open-Questions.md` ("Independent step versioning").

#### Scenario: `@1.0.0` pin is parsed off the reference

- **WHEN** the resolver is asked to resolve `minifac:openspec-propose@1.0.0` and the built-in resolves cleanly
- **THEN** the resolver returns the built-in path; the parsed pin is available to diagnostics; no error is raised even if the resolved step's `version:` does not equal `1.0.0`

#### Scenario: `@1` pin is parsed off the reference

- **WHEN** the resolver is asked to resolve `minifac:openspec-verify@1`
- **THEN** the resolver resolves the reference to the built-in path; the pin is preserved diagnostically; no error is raised

#### Scenario: Unversioned reference resolves the same as a pinned one

- **WHEN** the resolver is asked to resolve `minifac:openspec-archive` and `minifac:openspec-archive@1.0.0` against the same step library
- **THEN** both resolve to the same built-in path and load the same step object

#### Scenario: Empty pin is rejected

- **WHEN** the resolver is asked to resolve `minifac:openspec-propose@` (trailing `@` with nothing after it)
- **THEN** the resolver throws `StepLoadError` naming the offending value

### Requirement: Step loader error reporting

The step loader SHALL surface errors as `StepLoadError` carrying at minimum:

- the `sourcePath` of the file under consideration (when the error originates in a file), and
- a message naming the offending field, value, or reference.

For malformed YAML, the loader SHALL include the YAML line number (and column when available) in the error message, matching the `factory-schema` capability's error-reporting convention.

When a factory's node fails to resolve a step reference (e.g. missing file, malformed reference), the surfacing error SHALL name both the factory entry-point file (so the operator knows where to edit) and the offending `uses:` value. When a factory's node passes inputs that fail validation against the step's declared input schema, the error SHALL name the factory, the node id, the step's resolved `sourcePath`, the offending input key, and the validation failure (missing required / type mismatch / unknown key).

#### Scenario: Malformed step YAML reports a line number

- **WHEN** the loader reads a step YAML with a syntax error on line 9
- **THEN** the thrown `StepLoadError` includes line 9 (and column when available) in its message and carries `sourcePath` of the offending file

#### Scenario: Schema violation cites the step file

- **WHEN** the loader reads a step YAML whose `inputs:` declares an input with an unknown `type:` literal
- **THEN** the thrown `StepLoadError` names the offending input, the offending value, and the step's `sourcePath`
