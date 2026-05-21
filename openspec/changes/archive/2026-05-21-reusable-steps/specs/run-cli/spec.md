## ADDED Requirements

### Requirement: `minifac steps` subcommand

The CLI SHALL expose a `steps` subcommand that lists the steps
available for use by factory `uses:` references. The subcommand
SHALL accept the following options:

- `--source <local | built-in | all>` — filter by source. Defaults
  to `all`. `local` lists only steps under
  `<cwd>/.minifac/steps/*.yaml`; `built-in` lists only steps under
  `<cwd>/examples/steps/*.yaml`; `all` lists both.
- `--json` — emit a JSON array instead of the default plain-text
  table. Each array element SHALL be an object with the fields
  `name`, `version`, `source` (`"local"` | `"built-in"`),
  `path` (absolute), and `description` (string or `null`).

For each YAML file in scope, the subcommand SHALL attempt to load
it via the step loader (per the `step-schema` capability). On
successful load, the step's identity (`name`, `version`,
`description`) and its resolved source SHALL be included in the
listing. On a load failure (malformed YAML, schema violation), the
subcommand SHALL include a placeholder row that names the file path
and the load-error message, but SHALL NOT exit non-zero on a
per-file failure — discovery should not be aborted by a single
broken step.

The subcommand SHALL exit `0` on successful listing (including when
zero steps are discovered). It SHALL exit `1` only on usage errors
(e.g. an unrecognized `--source` value) or on a fatal I/O error
while scanning the source directories.

The subcommand SHALL NOT require a brief or a factory. It SHALL
NOT make any network call, SHALL NOT invoke `git`, and SHALL NOT
write to any file.

When both a local file and a built-in file share the same `name`,
the subcommand SHALL list both entries (one per source) in `all`
mode; consumers can disambiguate by the `source` column. The
subcommand SHALL NOT apply the bare-name lookup precedence (local
shadows built-in) when listing — the listing is descriptive, not
prescriptive.

#### Scenario: Lists built-in steps by default

- **WHEN** the user invokes `minifac steps` in a directory whose
  `<cwd>/examples/steps/` contains `openspec-propose.yaml`,
  `openspec-apply.yaml`, `openspec-verify.yaml`, and
  `openspec-archive.yaml`, and no `<cwd>/.minifac/steps/` directory
  exists
- **THEN** the CLI prints a four-row table (one row per step)
  containing each step's name, version, source (`built-in`), and
  description; exits `0`

#### Scenario: `--source local` filters to local only

- **WHEN** the user invokes `minifac steps --source local` in a
  directory whose `<cwd>/.minifac/steps/` contains
  `custom-verify.yaml` and whose `<cwd>/examples/steps/` contains
  four built-in steps
- **THEN** the CLI prints a one-row table for `custom-verify` with
  source `local`; the built-in steps are not listed; exits `0`

#### Scenario: `--source built-in` filters to built-in only

- **WHEN** the user invokes `minifac steps --source built-in` in a
  directory whose `<cwd>/.minifac/steps/` contains
  `custom-verify.yaml` and whose `<cwd>/examples/steps/` contains
  four built-in steps
- **THEN** the CLI prints a four-row table for the four built-in
  steps; the local step is not listed; exits `0`

#### Scenario: `--json` emits a JSON array

- **WHEN** the user invokes `minifac steps --json` in a directory
  with two built-in steps and no local steps
- **THEN** stdout contains a JSON array (parseable by
  `JSON.parse`) of two objects, each carrying `name`, `version`,
  `source`, `path`, and `description` fields; exits `0`

#### Scenario: Same-name local and built-in steps both list under `--source all`

- **WHEN** the user invokes `minifac steps` and both
  `<cwd>/.minifac/steps/openspec-verify.yaml` and
  `<cwd>/examples/steps/openspec-verify.yaml` exist
- **THEN** the listing contains two `openspec-verify` rows, one
  with `source: local` and one with `source: built-in`

#### Scenario: Empty directories produce an empty listing

- **WHEN** the user invokes `minifac steps` in a directory with
  no `.minifac/steps/` and no `examples/steps/` directories
- **THEN** the CLI prints a one-line "no steps found" summary (or
  an empty JSON array under `--json`) and exits `0`

#### Scenario: Malformed step file is listed with an error placeholder

- **WHEN** the user invokes `minifac steps` and one of the step
  files under `examples/steps/` has malformed YAML
- **THEN** the listing contains a row for the offending file whose
  `name` column is the file path and whose `version`/`description`
  columns contain the loader error message; the CLI continues to
  list the other files and exits `0`

#### Scenario: Unrecognized `--source` value is a usage error

- **WHEN** the user invokes `minifac steps --source remote`
- **THEN** the CLI writes a usage error to stderr explaining that
  `--source` accepts `local`, `built-in`, or `all`, and exits `1`

#### Scenario: Steps subcommand makes no external calls

- **WHEN** the user invokes `minifac steps` on a machine with no
  network
- **THEN** the CLI runs to completion without attempting any HTTP,
  LLM, or `git` call
