## MODIFIED Requirements

### Requirement: A project declares at most one library, pinned

A project MAY declare one **library** — a git repository of shared
steps and workflows — with a top-level `library:` mapping carrying
the two keys `repo` and `ref`, and optionally `range`:

```yaml
library:
  repo: twinsunllc/scarif-workflows
  ref: v0.1.0
  range: "~> 0.1"   # optional
```

The declaration SHALL be read from `<project-root>/factory.yaml` or
`<project-root>/.minifac/config.yaml`, where `<project-root>` is the
cwd the factory loader is given. A library declared in both files
SHALL be a load error naming both files. A `library:` value that is
not a mapping, lacks `repo` or `ref`, or carries any key other than
`repo`, `ref` and `range` SHALL be a load error naming the declaring
file.

`range`, when present, SHALL be a non-empty string; any other value
SHALL be a load error naming the declaring file. The loader SHALL NOT
interpret `range` and SHALL NOT use it to resolve or fetch the
library: the library is resolved at `ref` alone. Checking `ref`
against `range` belongs to the caller (Scarif's droid preflight,
scarif-spec change `factory-library-pin-ranges`).

`repo` SHALL be one of: `owner/name` (GitHub shorthand, mapped to
`https://github.com/owner/name.git`); an `https://`, `ssh://`, or
`file://` URL; an scp-style `user@host:path`; or an absolute
filesystem path. Any other value, including other git transports,
SHALL be a load error.

A project with no `library:` declaration SHALL NOT fetch anything and
SHALL resolve every reference exactly as it did before this
capability existed, apart from the factory-repo layout rule below.

#### Scenario: factory.yaml carries the pin

- **WHEN** `<project-root>/factory.yaml` declares `library: { repo:
  acme/lib, ref: v0.1.0 }`
- **THEN** the loader resolves `library:` references against
  `acme/lib` at `v0.1.0`

#### Scenario: A declared range does not move the pin

- **WHEN** `<project-root>/factory.yaml` declares `library: { repo:
  acme/lib, ref: v0.1.0, range: "~> 0.1" }` and `acme/lib` has also
  published `v0.1.5`
- **THEN** the loader resolves `library:` references against
  `acme/lib` at `v0.1.0`

#### Scenario: A range that is not a string is refused

- **WHEN** `factory.yaml` declares `library: { repo: acme/lib, ref:
  v0.1.0, range: 2.23 }` (a YAML number)
- **THEN** the load fails naming `factory.yaml` and `library.range`

#### Scenario: Two declarations are refused

- **WHEN** both `factory.yaml` and `.minifac/config.yaml` declare
  `library:`
- **THEN** the load fails naming both files

#### Scenario: No declaration, no fetch

- **WHEN** neither file declares `library:` and no reference uses the
  `library:` namespace
- **THEN** the load completes without contacting any remote
