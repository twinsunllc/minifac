## MODIFIED Requirements

### Requirement: Required and optional frontmatter fields

The brief frontmatter SHALL have the following typed shape:

| Field         | Required | Type                       | Purpose                                                    |
|---------------|----------|----------------------------|------------------------------------------------------------|
| `change`      | yes      | string                     | The change name (kebab-case by convention, not enforced)   |
| `factory`     | yes      | string                     | Factory reference resolved against the factory-name lookup |
| `base_branch` | no       | string                     | Branch this change should be based on                      |
| `model`       | no       | string                     | Per-brief Claude model override                            |
| `mode`        | no       | literal `"in-place"`       | When set, the CLI runs the factory in `process.cwd()` instead of creating a worktree |

The loader SHALL be strict on required-field presence and on known-field
types: a missing `change` or `factory`, or a non-string value for any
of the string fields, SHALL produce a load error naming the
offending field and (when available) its actual type or location.
For the `mode` field, any value other than the literal `"in-place"`
SHALL produce a load error naming the offending value and listing
the supported literal.

The loader SHALL be permissive on unknown extras: any frontmatter key
not in the table above SHALL pass through to the returned object
without error. Future schemas (e.g. `depends_on`, `priority`, `tags`)
slot in without requiring a migration.

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

#### Scenario: Unknown extras pass through without error

- **WHEN** the loader reads a brief whose frontmatter is
  `{ change: "foo", factory: "sdd", depends_on: ["bar"], priority: "high" }`
- **THEN** the loader returns a typed object whose frontmatter
  contains the two required fields *and* `depends_on` and `priority`
  preserved verbatim, with no error
