## ADDED Requirements

### Requirement: `minifac brief` subcommand

The CLI SHALL expose a `brief` subcommand that takes a single
positional argument `<name>` and writes a brief file conforming to
the `brief-schema` capability. The subcommand SHALL accept the
following options:

- `--from <file>`: read answers from a YAML or JSON file (detected
  by extension) instead of prompting interactively.
- `--out <path>`: override the default output path. When omitted,
  the brief is written to `inputs/<name>.md` relative to the CLI's
  invocation cwd.
- `--force`: overwrite an existing output file. Without this flag,
  an existing file at the resolved output path is a usage error.

The subcommand SHALL delegate to the `brief-authoring` capability's
question schema and renderer; the on-disk shape SHALL match the
file the capability's renderer would produce for the same answers.

The subcommand SHALL NOT make any HTTP, LLM, or other network call.
It SHALL NOT invoke `git` or write outside the resolved output
path.

#### Interactive mode (default)

When invoked without `--from`, the subcommand SHALL drive an
interactive flow over `process.stdin` / `process.stdout` (or
injected I/O streams in tests). For each question in the
`brief-authoring` capability's schema, in order, the subcommand
SHALL:

- print the question's prompt followed by a newline,
- read one line of input,
- treat an empty line as "no answer" for that question (re-asking
  if the question is required, omitting it if optional),
- accept a sentinel input (`:q` or EOF / SIGINT) as a request to
  stop the flow early.

On normal completion, the subcommand SHALL invoke the renderer,
write the file, invoke `loadBrief` on the written file to verify
round-trip validity, print the absolute path of the written file
to stdout on its own line, and exit `0`.

On early stop, the subcommand SHALL apply the `brief-authoring`
capability's partial-brief behavior (write a file with the
incomplete-marker block when the required frontmatter is complete;
exit non-zero without writing when it is not), print the path of
the written file (if any) and a stderr line naming the
next-unanswered question, and exit `0` (partial) or non-zero
(nothing written).

#### Non-interactive mode (`--from <file>`)

When invoked with `--from <file>`, the subcommand SHALL read the
named file and parse it as YAML (extension `.yaml` or `.yml`) or
JSON (extension `.json`). The parsed value SHALL be an object whose
keys are `AuthoringQuestionId` literals and whose values are
strings. The subcommand SHALL:

- reject unknown keys with a usage error naming the offending key
  and the supported ids,
- reject missing required answers with a usage error naming the
  missing question ids,
- reject non-string values with a usage error naming the offending
  key and its actual type,
- on success, invoke the renderer, write the file, invoke
  `loadBrief` on the written file, print the absolute output path
  to stdout, and exit `0`.

A `--from` file whose extension is neither `.yaml`, `.yml`, nor
`.json` SHALL produce a usage error naming the supported
extensions.

#### TTY requirement

If `--from` is not supplied and `process.stdin` is not a TTY, the
subcommand SHALL exit `1` with a usage error suggesting
`--from <file>`. This prevents the interactive flow from hanging in
non-TTY environments (CI, piped invocations).

#### Scenario: Interactive happy path writes inputs/<name>.md

- **WHEN** the user invokes `minifac brief my-change` interactively and answers each required question with non-empty text
- **THEN** the CLI writes a brief to `inputs/my-change.md`, prints that absolute path to stdout on its own line, invokes `loadBrief` on the file successfully, and exits `0`

#### Scenario: --from happy path

- **WHEN** the user invokes `minifac brief my-change --from answers.yaml` and `answers.yaml` is a YAML object with all required answers
- **THEN** the CLI writes a brief to `inputs/my-change.md`, the produced file matches what the renderer would emit for those answers, the file loads cleanly through `loadBrief`, and the CLI exits `0`

#### Scenario: --out overrides destination

- **WHEN** the user invokes `minifac brief my-change --out /tmp/custom.md --from answers.yaml`
- **THEN** the brief is written to `/tmp/custom.md` and nothing is written under `inputs/`

#### Scenario: Existing file without --force is a usage error

- **WHEN** the user invokes `minifac brief my-change` and `inputs/my-change.md` already exists
- **THEN** the CLI exits `1` writing a stderr message naming the existing file and the `--force` escape hatch; the file is left unchanged

#### Scenario: --force overwrites

- **WHEN** the user invokes `minifac brief my-change --force --from answers.yaml` and `inputs/my-change.md` already exists
- **THEN** the CLI overwrites the file with the new content and exits `0`

#### Scenario: --from rejects unknown keys

- **WHEN** the user invokes `minifac brief my-change --from answers.yaml` and `answers.yaml` contains a top-level key `wat` that is not an `AuthoringQuestionId`
- **THEN** the CLI exits `1` with a stderr message naming `wat` and listing the supported ids

#### Scenario: --from rejects missing required answers

- **WHEN** the user invokes `minifac brief my-change --from answers.yaml` and `answers.yaml` is missing a required answer (e.g. `acceptance_criteria`)
- **THEN** the CLI exits `1` with a stderr message naming the missing required question id

#### Scenario: --from rejects unsupported file extension

- **WHEN** the user invokes `minifac brief my-change --from answers.toml`
- **THEN** the CLI exits `1` with a stderr message naming the supported extensions (`.yaml`, `.yml`, `.json`)

#### Scenario: Interactive stop after required frontmatter writes partial

- **WHEN** the user answers `change` and `factory`, then sends EOF before answering `background`
- **THEN** the CLI writes a partial brief whose body begins with the incomplete-marker block naming `background`, prints the written path to stdout, prints a stderr line naming the next-unanswered question, and exits `0`

#### Scenario: Interactive stop before required frontmatter writes nothing

- **WHEN** the user sends EOF before answering `change`
- **THEN** the CLI writes no file, prints a stderr message naming the missing required frontmatter, and exits non-zero

#### Scenario: Non-TTY without --from is a usage error

- **WHEN** the user invokes `minifac brief my-change` with `process.stdin` not a TTY and no `--from` flag
- **THEN** the CLI exits `1` with a stderr message suggesting `--from <file>`

#### Scenario: Subcommand does not invoke external services

- **WHEN** the user invokes `minifac brief my-change` (interactive or `--from`) on a machine with no network
- **THEN** the CLI runs to completion without attempting any HTTP, LLM, or other network call
