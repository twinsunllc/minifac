## MODIFIED Requirements

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
