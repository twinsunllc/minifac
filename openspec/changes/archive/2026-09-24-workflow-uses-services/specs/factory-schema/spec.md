## ADDED Requirements

### Requirement: Workflow `uses_services:` top-level field

The factory schema SHALL accept an optional top-level `uses_services:`
field on a workflow. When present its value MUST be a list of unique,
non-empty strings, each naming a service that the factory repo's
`factory.yaml` manifest defines under `services:` (scarif-spec
`ec2-per-job-lane`, ruling 3). A workflow selects services; it SHALL
NOT define one.

The loader SHALL refuse, with a `FactoryLoadError` whose source is the
file that declares the field and whose message names the
`uses_services` key:

- a value that is not a list (a scalar, or a map of service
  definitions);
- a list entry that is an empty string or not a string;
- a list with a repeated entry.

The loader SHALL NOT check the names against the manifest or against a
name pattern; Scarif does that when a job is ordered.

`uses_services:` SHALL NOT be inherited through `extends:`. The
resolved factory SHALL carry the list declared by the loaded (entry)
file, unchanged, and SHALL carry no `uses_services` when that file
omits it, whatever its bases declare. A base's list SHALL NOT be merged
into the entry file's list. Every layer's value is still validated.

The runner SHALL carry the resolved list and SHALL NOT act on it: no
node dispatch, executor, run record or storage behaviour depends on it.

The loader SHALL NOT read a `services:` block in a factory repo's
`factory.yaml`. Its presence SHALL NOT change how the project's
`library:` pin resolves or how any workflow in the repo loads.

#### Scenario: A list of service names loads and is carried

- **WHEN** the loader reads a workflow declaring
  `uses_services: [mysql, valkey]`
- **THEN** it loads, and the resolved factory's `uses_services` is
  `["mysql", "valkey"]`

#### Scenario: A malformed value is refused, naming the file and the key

- **WHEN** the loader reads a workflow whose `uses_services:` is the
  scalar `mysql`, a map `{mysql: {image: ...}}`, `[""]`, `[mysql, 7]`
  or `[mysql, mysql]`
- **THEN** loading fails with a `FactoryLoadError` whose source is the
  workflow file and whose message begins
  `Schema error at uses_services`

#### Scenario: A derived workflow's own list is used

- **WHEN** a workflow declaring `extends: base` and
  `uses_services: [valkey]` is loaded, and `base` declares
  `uses_services: [mysql]`
- **THEN** the resolved `uses_services` is `["valkey"]`

#### Scenario: A base's list is not inherited

- **WHEN** a workflow declaring `extends: base` and no
  `uses_services:` is loaded, and `base` declares
  `uses_services: [mysql, valkey]`
- **THEN** the resolved factory has no `uses_services`

#### Scenario: A manifest `services:` block does not affect loading

- **WHEN** a factory repo's `factory.yaml` declares a `services:` block
  alongside a `library:` pin, and a workflow in `workflows/` extends
  `library:<name>`
- **THEN** the library resolves to its pinned sha and the workflow's
  resolved factory equals the one loaded from the same repo without
  the `services:` block

## MODIFIED Requirements

### Requirement: Factory `extends:` top-level field

The factory schema SHALL accept an optional top-level `extends:` field whose value, when present, MUST be a single non-empty string identifying a base factory to extend. The string SHALL be one of:

- `minifac:<built-in-name>` — a reference to a built-in factory.
  Resolution uses the install-root-first / source-tree-fallback
  precedence defined in the "`extends:` chain resolution rules"
  requirement below.
- `library:<name>` — a reference to a workflow in the project's
  pinned library (per the `library-resolution` capability).
- `<local-name>` (no prefix) — a reference to another custom factory,
  resolved against the local layer and then the library per the
  "`extends:` chain resolution rules" requirement below. Such
  references MAY themselves declare an `extends:` field (recursive
  extension).

When the loader reads a factory file with `extends:` set, it SHALL
resolve the chain into a single in-memory factory before running any
schema-level or post-schema validation. A factory file without
`extends:` SHALL be loaded as-is, preserving today's single-file
behavior.

The `extends:` key SHALL be valid as a top-level key alongside the
existing documented keys (`name`, `description`, `brief`, `nodes`,
`edges`, `uses_services`). The factory schema's strict-on-extras rule
SHALL continue to reject any other unknown top-level key.

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
  `nodes`, `edges`, `extends`, `uses_services`) — e.g. `inherits:` or
  `services:`
- **THEN** schema validation fails with an error naming the
  offending key
