## MODIFIED Requirements

### Requirement: Factory `extends:` top-level field

The factory schema SHALL accept an optional top-level `extends:` field whose value, when present, MUST be a single non-empty string identifying a base factory to extend. The string SHALL be one of:

- `minifac:<built-in-name>` — a reference to a built-in factory.
  Resolution uses the install-root-first / source-tree-fallback
  precedence defined in the "`extends:` chain resolution rules"
  requirement below.
- `<local-name>` (no prefix) — a reference to another local custom
  factory at `<callerCwd>/.minifac/factories/<local-name>.yaml`.
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
the loader is given (the calling repo root) and the runner's install
root:

- A `minifac:<name>` reference SHALL be resolved using an install-
  root-first / source-tree-fallback two-step lookup:
    1. `<install-root>/examples/<name>.yaml`, where `<install-root>`
       is the directory containing the running runner's `package.json`.
    2. `<callerCwd>/examples/<name>.yaml`.
  The first existing file wins. When running from the minifac source
  tree, the two paths collapse to the same file. If neither path
  exists, the loader SHALL throw `FactoryLoadError` whose message
  names the reference and both candidate absolute paths in order.
- A `<name>` reference (no prefix) SHALL resolve to
  `<callerCwd>/.minifac/factories/<name>.yaml`. If that path does
  not exist, the loader SHALL throw `FactoryLoadError` naming both
  the reference and the path tried. The install root SHALL NOT be
  consulted for bare references.
- A reference whose value contains a path separator or extension
  (e.g. `extends: ../factories/foo.yaml`) SHALL be rejected with a
  `FactoryLoadError` naming the offending value; only `minifac:<name>`
  and bare `<name>` are valid forms in v0.

The loader SHALL detect cycles in the `extends:` chain. If the same
absolute factory path is visited twice while walking `extends:`, the
loader SHALL throw `FactoryLoadError` naming the cycle (the sequence
of files involved) and the file whose `extends:` closed the loop.

The loader SHALL surface resolution errors with the same
`FactoryLoadError` shape used elsewhere — including the `sourcePath`
of the file where the failing `extends:` was declared, so the
operator knows which file to edit.

#### Scenario: `minifac:<name>` resolves to install-root examples

- **WHEN** the loader reads `.minifac/factories/sdd.yaml` whose
  `extends:` field is `minifac:sdd`, `<install-root>/examples/sdd.yaml`
  exists and is a valid factory, and the loader was given an arbitrary
  `<callerCwd>`
- **THEN** the loader resolves the base to
  `<install-root>/examples/sdd.yaml` and proceeds to merge layers
  without error; the source-tree fallback is not consulted

#### Scenario: `minifac:<name>` falls back to source-tree examples

- **WHEN** the loader reads `.minifac/factories/sdd.yaml` whose
  `extends:` field is `minifac:sdd`,
  `<install-root>/examples/sdd.yaml` does not exist, and
  `<callerCwd>/examples/sdd.yaml` exists and is a valid factory
- **THEN** the loader resolves the base to
  `<callerCwd>/examples/sdd.yaml` and proceeds to merge layers
  without error

#### Scenario: Bare `<name>` resolves to .minifac/factories/<name>.yaml

- **WHEN** the loader reads `.minifac/factories/sdd-fast.yaml` whose
  `extends:` field is `sdd`, and
  `<callerCwd>/.minifac/factories/sdd.yaml` exists and is a valid factory
- **THEN** the loader resolves the base to
  `<callerCwd>/.minifac/factories/sdd.yaml` and proceeds to merge
  layers without error

#### Scenario: Bare `<name>` does not consult the install root

- **WHEN** the loader reads a factory whose `extends:` is `sdd`,
  `<install-root>/examples/sdd.yaml` exists, and
  `<callerCwd>/.minifac/factories/sdd.yaml` does not exist
- **THEN** the loader throws `FactoryLoadError` naming the reference
  and only the local path tried; the install root is not consulted

#### Scenario: Missing `minifac:<name>` is rejected at load time with both paths

- **WHEN** the loader reads `.minifac/factories/sdd.yaml` whose
  `extends:` is `minifac:nonexistent`, neither
  `<install-root>/examples/nonexistent.yaml` nor
  `<callerCwd>/examples/nonexistent.yaml` exists
- **THEN** the loader throws `FactoryLoadError` whose message names
  the reference, the install-root path, and the source-tree fallback
  path, in that order; `sourcePath` is the declaring factory file

#### Scenario: Missing local base file is rejected at load time

- **WHEN** the loader reads `.minifac/factories/sdd-fast.yaml`
  whose `extends:` is `sdd-base` and
  `<callerCwd>/.minifac/factories/sdd-base.yaml` does not exist
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
