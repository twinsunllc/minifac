# brief-schema Specification

## Purpose
TBD - created by archiving change factory-inputs-core. Update Purpose after archive.
## Requirements
### Requirement: Brief file format

A brief SHALL be a markdown file consisting of a YAML frontmatter
block followed by a free-form markdown body. The frontmatter block
SHALL be delimited by a `---` line at the very start of the file (line
1) and a subsequent `---` line on its own line. Everything between
those fences SHALL be parsed as YAML; everything after the closing
fence (with one optional leading newline stripped) SHALL be the body
string. A file without an opening fence on line 1 SHALL be rejected as
a load error naming the missing frontmatter. A file with an opening
fence but no closing fence SHALL be rejected as a load error naming
the unterminated frontmatter. A file with frontmatter but no body
SHALL be valid; the body string SHALL be the empty string.

#### Scenario: Frontmatter plus body parses cleanly

- **WHEN** the loader reads a file whose contents are
  `---\nchange: foo\nfactory: sdd\n---\n# Body\n\nparagraph`
- **THEN** the returned object has frontmatter
  `{ change: "foo", factory: "sdd" }` and body `"# Body\n\nparagraph"`

#### Scenario: Missing opening fence is rejected

- **WHEN** the loader reads a file whose first line is not `---`
- **THEN** the loader throws a load error naming the missing
  frontmatter and the source path

#### Scenario: Unterminated frontmatter is rejected

- **WHEN** the loader reads a file that begins with `---` but contains
  no second `---` line
- **THEN** the loader throws a load error naming the unterminated
  frontmatter and the source path

#### Scenario: Empty body is valid

- **WHEN** the loader reads a file whose contents are
  `---\nchange: foo\nfactory: sdd\n---\n`
- **THEN** the returned object has body `""` and no error

### Requirement: Required and optional frontmatter fields

The brief frontmatter SHALL have the following typed shape:

| Field         | Required | Type                       | Purpose                                                                                          |
|---------------|----------|----------------------------|--------------------------------------------------------------------------------------------------|
| `change`      | yes      | string                     | The change name (kebab-case by convention, not enforced)                                         |
| `factory`     | yes      | string                     | Default factory reference for the brief, resolved against the factory-name lookup. Overridable at invocation time via the `run-cli` capability's `--factory` flag. |
| `base_branch` | no       | string                     | Branch this change should be based on                                                            |
| `model`       | no       | string                     | Per-brief Claude model override                                                                  |
| `mode`        | no       | literal `"in-place"`       | When set, the CLI runs the factory in `process.cwd()` instead of creating a worktree             |
| `depends_on`  | no       | string[]                   | Names of other briefs whose completion is a precondition for running this brief                  |

The `factory:` field is required so every brief is self-describing:
opening the file makes it unambiguous which factory the brief was
authored against. The field defines the *default* factory used by
`minifac run <brief>` invocations that pass no `--factory` flag;
the `run-cli` capability defines the override mechanism and its
resolution rules (the override reuses the same factory-by-name
precedence as this field).

The loader SHALL be strict on required-field presence and on known-field
types: a missing `change` or `factory`, or a non-string value for any
of the string fields, SHALL produce a load error naming the
offending field and (when available) its actual type or location.
For the `mode` field, any value other than the literal `"in-place"`
SHALL produce a load error naming the offending value and listing
the supported literal. For the `depends_on` field, a non-array value
or an array containing any non-string or empty-string element SHALL
produce a load error naming the offending element. When the
`depends_on` field is absent, the loader SHALL surface it on the
parsed object as the empty array `[]` so downstream code never
inspects `undefined`.

The loader SHALL be permissive on unknown extras: any frontmatter key
not in the table above SHALL pass through to the returned object
without error. Future schemas (e.g. `priority`, `tags`) slot in
without requiring a migration.

#### Scenario: Required fields present, no extras

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd" }`
- **THEN** the loader returns a typed object whose frontmatter has
  `change === "foo"` and `factory === "sdd"`, with no error

#### Scenario: Missing required field is rejected

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo" }` (no `factory`)
- **THEN** the loader throws a load error naming the missing
  `factory` field

#### Scenario: Wrong-type known field is rejected

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: 42, factory: "sdd" }`
- **THEN** the loader throws a load error naming the `change` field
  and the type mismatch

#### Scenario: Optional fields parse when present

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", base_branch: "main", model: "claude-opus-4-7" }`
- **THEN** all four fields appear on the typed object with their
  declared values

#### Scenario: `mode: in-place` parses

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", mode: "in-place" }`
- **THEN** the loader returns a typed object whose frontmatter has
  `mode === "in-place"`, with no error

#### Scenario: Unknown mode value is rejected

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", mode: "yolo" }`
- **THEN** the loader throws a load error naming the offending
  value and the supported literal (`"in-place"`)

#### Scenario: `depends_on` defaults to empty array when absent

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd" }`
- **THEN** the returned object's frontmatter exposes
  `depends_on` as the empty array `[]`

#### Scenario: `depends_on` parses when present

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", depends_on: ["bar", "baz"] }`
- **THEN** the returned object's frontmatter exposes `depends_on`
  as the array `["bar", "baz"]` in declared order

#### Scenario: `depends_on` rejects non-array value

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", depends_on: "bar" }`
- **THEN** the loader throws a load error naming the
  `depends_on` field and the array-of-strings requirement

#### Scenario: `depends_on` rejects non-string element

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", depends_on: ["bar", 42] }`
- **THEN** the loader throws a load error naming the offending
  element (`42`) and the array-of-strings requirement

#### Scenario: `depends_on` rejects empty-string element

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", depends_on: ["bar", ""] }`
- **THEN** the loader throws a load error naming the empty-string
  element and the non-empty requirement

#### Scenario: Unknown extras pass through without error

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", priority: "high", tags: ["x"] }`
- **THEN** the loader returns a typed object whose frontmatter
  contains the two required fields *and* `priority` and `tags`
  preserved verbatim, with no error

#### Scenario: Brief file is not modified by invocation-time override

- **WHEN** the user invokes `minifac run foo --factory bar` (per
  the `run-cli` capability) against `inputs/foo.md` whose
  frontmatter declares `factory: sdd`
- **THEN** `inputs/foo.md` is byte-for-byte identical on disk
  after the run as before; the loader continues to return
  `factory === "sdd"` for that file

### Requirement: Brief location convention and name-based discovery

Briefs SHALL live at `inputs/<change>.md` relative to the directory
from which the CLI is invoked. The brief loader SHALL accept either:

- a filesystem path (absolute or relative to cwd) ending in `.md`, or
- a bare name (no path separator, no `.md` suffix), which the loader
  SHALL resolve to `inputs/<name>.md` relative to the CLI's cwd.

The loader SHALL surface a clear, named error when the resolved path
does not exist. Discovery of *which* of these inputs the CLI receives
is the run-cli capability's responsibility (see the `run-cli`
spec's "run subcommand" requirement); this requirement binds the
loader's input contract.

#### Scenario: Bare name resolves to inputs/<name>.md

- **WHEN** the loader is invoked with the bare name `factory-inputs-core`
  and `inputs/factory-inputs-core.md` exists in the cwd
- **THEN** the loader reads `inputs/factory-inputs-core.md` and
  returns its parsed brief

#### Scenario: Path-like argument is used verbatim

- **WHEN** the loader is invoked with `./custom/path/foo.md` and that
  file exists
- **THEN** the loader reads that file and returns its parsed brief

#### Scenario: Missing brief file is reported clearly

- **WHEN** the loader is invoked with a name or path that does not
  resolve to an existing file
- **THEN** the loader throws an error naming the resolved path it
  attempted to read

### Requirement: Brief loader returns a typed object with frontmatter and body

The brief loader's return value SHALL be a typed object exposing at
least:

- `frontmatter` — the parsed frontmatter object with the typed required
  and optional fields, plus any pass-through extras as unknown-typed
  properties
- `body` — the post-fence markdown string
- `sourcePath` — the absolute path to the loaded brief file

The returned object SHALL be the single value consumed by downstream
code (the runner's substitution step, the CLI's mode-check, future
features that read briefs).

#### Scenario: Returned object exposes frontmatter, body, sourcePath

- **WHEN** the loader successfully reads a brief at
  `/repo/inputs/foo.md`
- **THEN** the returned object's `sourcePath` is `/repo/inputs/foo.md`,
  its `frontmatter` is the parsed typed object, and its `body` is the
  markdown string after the closing fence

