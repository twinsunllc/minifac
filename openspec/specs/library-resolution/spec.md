# library-resolution Specification

## Purpose
How a project pins one shared library of steps and workflows, how the
loader fetches and caches it at an immutable ref, and how the resolved
pin is recorded. The `library:` reference forms themselves are specified
in `step-schema` and `factory-schema`; see ADR 0039.
## Requirements
### Requirement: A project declares at most one library, pinned

A project MAY declare one **library** — a git repository of shared
steps and workflows — with a top-level `library:` mapping carrying
exactly two keys:

```yaml
library:
  repo: twinsunllc/scarif-workflows
  ref: v0.1.0
```

The declaration SHALL be read from `<project-root>/factory.yaml` or
`<project-root>/.minifac/config.yaml`, where `<project-root>` is the
cwd the factory loader is given. A library declared in both files
SHALL be a load error naming both files. A `library:` value that is
not a mapping, lacks `repo` or `ref`, or carries any other key SHALL
be a load error naming the declaring file.

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

#### Scenario: Two declarations are refused

- **WHEN** both `factory.yaml` and `.minifac/config.yaml` declare
  `library:`
- **THEN** the load fails naming both files

#### Scenario: No declaration, no fetch

- **WHEN** neither file declares `library:` and no reference uses the
  `library:` namespace
- **THEN** the load completes without contacting any remote

### Requirement: A factory repo's root steps/ and workflows/ are the local layer

A project whose root carries `factory.yaml` SHALL be treated as a
**factory repo**: its root `steps/` directory SHALL join
`.minifac/steps/`, and its root `workflows/` directory SHALL join
`.minifac/factories/`, as the local layer for step references,
`extends:` references, and factory-by-name lookup. In each case the
`.minifac/` location SHALL be consulted first. A project without
`factory.yaml` SHALL NOT consult root `steps/` or `workflows/`.

#### Scenario: A factory repo's workflows/ resolves a factory name

- **WHEN** a project has `factory.yaml` and `workflows/impl.yaml`
- **THEN** factory-by-name resolution of `impl` returns
  `workflows/impl.yaml`

#### Scenario: An ordinary repo's steps/ is not a lookup location

- **WHEN** a project without `factory.yaml` has `steps/review.yaml`
- **THEN** a bare `uses: review` does not resolve to it

### Requirement: The library pin is immutable

`library.ref` SHALL be a tag name or a full 40-character lowercase
hexadecimal commit sha.

- `HEAD`, a `refs/...` spelling, a revision expression (containing
  `~`, `^`, `:`, `..`, or whitespace), or a value beginning with `-`
  SHALL be refused before any remote is contacted.
- A ref that names a **branch** in the library (and no tag) SHALL be
  refused with an error naming the ref and stating that a branch is
  not an immutable pin.
- A ref that is an **abbreviated** hexadecimal sha (4–39 characters)
  and names no tag SHALL be refused with an error naming the ref and
  stating that an abbreviated sha is not an immutable pin.
- When a name is both a tag and a branch, the tag SHALL win.

A tag SHALL resolve to its commit sha **once**: the first resolution
of a tag SHALL be recorded in the cache, and a later resolution in
which the tag points at a different commit SHALL be a load error
naming the tag, both shas, and advising a full-sha pin.

#### Scenario: A branch pin is rejected

- **WHEN** `library.ref` is `main` and `main` is a branch in the
  library
- **THEN** the load fails naming `main` as a non-immutable ref

#### Scenario: An abbreviated sha is rejected

- **WHEN** `library.ref` is the first seven characters of a commit
  sha
- **THEN** the load fails naming the ref as an abbreviated sha

#### Scenario: A tag resolves to its sha

- **WHEN** `library.ref` is `v0.1.0`, an annotated tag
- **THEN** the library resolves to the commit the tag points at

#### Scenario: A full sha resolves to itself

- **WHEN** `library.ref` is a 40-character sha reachable from a
  branch or tag in the library
- **THEN** the library resolves to that commit

#### Scenario: A moved tag is refused

- **WHEN** `v0.1.0` resolved to commit A on a previous load and the
  library's `v0.1.0` now points at commit B
- **THEN** the load fails naming `v0.1.0`, A, and B

### Requirement: The library is fetched into a content-addressed cache

The loader SHALL mirror each library repository, bare, under
`$MINIFAC_HOME/cache/library/<key>/mirror.git`, where `<key>` is
derived from the repository URL, and SHALL materialize the tree at
each resolved sha exactly once at `$MINIFAC_HOME/cache/library/<key>/<sha>/`.
The materialized tree SHALL contain the commit's files and no git
metadata, and SHALL be written to a temporary location and moved into
place so that a concurrent load never observes a partial tree.

- **Cold cache.** When no mirror exists, the loader SHALL clone one.
  If the clone fails, the load SHALL fail with an error naming the
  pinned ref and stating that the library could not be fetched and
  nothing is cached.
- **Warm cache.** When a mirror exists, the loader SHALL refresh it
  (branches and tags, pruning refs deleted remotely) before resolving
  the pin. When the refresh fails because the remote is unreachable,
  the loader SHALL resolve the pin from the mirror as last fetched and
  SHALL emit a warning naming the library and the cached ref and sha.

Remote access SHALL use the host's git configuration and credentials,
and SHALL NOT prompt interactively. Resolution of a given pin SHALL
happen at most once per process.

A library's steps are read from `<tree>/steps/<name>.yaml` and its
workflows from `<tree>/workflows/<name>.yaml`; nothing else in the
tree is consulted.

#### Scenario: Cold cache fetches the library

- **WHEN** a project pins a library that has never been fetched and
  the remote is reachable
- **THEN** the library is cloned and the tree at the resolved sha is
  materialized under `$MINIFAC_HOME/cache/library/`

#### Scenario: Warm cache works offline

- **WHEN** the library was fetched on an earlier load and its remote
  is now unreachable
- **THEN** the load resolves the pin from the cache and emits a
  warning naming the cached ref

#### Scenario: Cold cache with no network fails loudly

- **WHEN** a project pins a library that has never been fetched and
  the remote is unreachable
- **THEN** the load fails naming the pinned ref

### Requirement: A stale pin fails the load

A pin SHALL be **stale** when, after a successful refresh of the
mirror, the pinned tag no longer exists in the library, or the pinned
sha is no longer reachable from any of the library's branches or
tags. A stale pin SHALL fail the load before any node is dispatched,
with an error naming the pinned ref and the library's current state:
its default-branch head (branch name and sha) and its latest tag.

#### Scenario: A deleted tag is stale

- **WHEN** `library.ref` is `v0.1.0`, which was fetched earlier, and
  the library no longer has a `v0.1.0` tag
- **THEN** the load fails naming `v0.1.0` and the library's
  default-branch head

#### Scenario: An unreachable sha is stale

- **WHEN** `library.ref` is a full sha that was reachable only from a
  branch the library has since deleted
- **THEN** the load fails naming the sha and the library's latest tag

### Requirement: The resolved pin is part of the loaded factory

When the project declares a library, `loadFactory` SHALL return the
pin in effect — `{ repo, ref, sha }`, where `sha` is the commit the
ref resolved to — as `LoadedFactory.library`, and the graph runner
SHALL persist it on the run row (per the `run-storage` capability's
schema v5 requirement). When the project declares no library,
`LoadedFactory.library` SHALL be absent and the run row's library
columns SHALL be `NULL`.

#### Scenario: A run records the library sha

- **WHEN** a factory loads against a library pinned at `v0.1.0`,
  which resolves to sha S, and the run starts
- **THEN** the run's stored row carries `library.repo`, `library.ref
  = v0.1.0`, and `library.sha = S`

