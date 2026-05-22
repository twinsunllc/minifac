# brief-cleanliness Specification

## Purpose
TBD - created by archiving change brief-cleanliness-gate. Update Purpose after archive.
## Requirements
### Requirement: Brief cleanliness probe

The system SHALL expose a `checkBriefCleanliness(briefPath, repoRoot)`
function that classifies a brief file as one of:

- `{ status: "clean" }` — the brief file's working-tree content
  matches the index AND the index matches HEAD (i.e. there is no
  outstanding modification, addition, or untracked state).
- `{ status: "unclean", code }` — the brief file is untracked,
  tracked-but-modified, staged-but-uncommitted, or in any other
  state that `git status --porcelain` reports for it. `code` is the
  exact two-character porcelain status code from the first line of
  output (e.g. `"??"`, `" M"`, `"A "`).
- `{ status: "disabled", reason: "not-a-git-repo" }` — the
  `repoRoot` is not a git working tree (i.e. `git -C <repoRoot>
  status` fails with the "not a git repository" error message).

The probe SHALL be implemented by invoking `git -C <repoRoot>
status --porcelain -- <briefPath>` using the same git-subprocess
helper used by the merge subcommand. The probe MUST NOT introduce
a second git wrapper.

The probe SHALL NOT mutate any state and SHALL be safe to call
concurrently.

#### Scenario: Committed brief is clean

- **WHEN** `checkBriefCleanliness("inputs/foo.md", repoRoot)` is
  called and `inputs/foo.md` is tracked in git with no working-tree
  modifications and no staged changes
- **THEN** the result is `{ status: "clean" }`

#### Scenario: Untracked brief is unclean with code "??"

- **WHEN** `checkBriefCleanliness("inputs/foo.md", repoRoot)` is
  called and `inputs/foo.md` exists on disk but has never been
  `git add`ed
- **THEN** the result is `{ status: "unclean", code: "??" }`

#### Scenario: Modified-but-tracked brief is unclean with code " M"

- **WHEN** `checkBriefCleanliness("inputs/foo.md", repoRoot)` is
  called and `inputs/foo.md` is tracked but the working-tree copy
  differs from the index
- **THEN** the result is `{ status: "unclean", code: " M" }`

#### Scenario: Staged-but-uncommitted brief is unclean with code "A "

- **WHEN** `checkBriefCleanliness("inputs/foo.md", repoRoot)` is
  called and `inputs/foo.md` has been `git add`ed but never
  committed
- **THEN** the result is `{ status: "unclean", code: "A " }`

#### Scenario: Non-git directory yields disabled

- **WHEN** `checkBriefCleanliness("inputs/foo.md", repoRoot)` is
  called and `repoRoot` is a directory outside any git working tree
- **THEN** the result is
  `{ status: "disabled", reason: "not-a-git-repo" }`

### Requirement: Recursive ancestor cleanliness check

The system SHALL expose a
`checkBriefAndAncestorsCleanliness(rootBrief, opts)` function that
walks the brief's `depends_on` graph and surfaces the first unclean
brief encountered.

`opts` SHALL include:

- `inputsDir` — the watch directory holding `<change>.md` files.
- `repoRoot` — the git working-tree root, passed through to the
  underlying probe.
- `loadBrief(change)` — an async loader returning the `Brief`
  object for a sibling change, mirroring the loader used by the
  brief-state computation.

Traversal rules:

1. The root brief itself is checked first. If unclean, the result
   is `{ status: "unclean", offending: <rootChange>, code }` and
   the walk terminates.
2. Each `depends_on` entry is resolved against `inputsDir`. If the
   resolved file does NOT exist (i.e. the dep is a sentinel like
   `callback-status-signaling-design-pending`), it SHALL be
   skipped — sentinels do not participate in cleanliness checks.
3. Each resolved ancestor brief is probed; if unclean, the result
   is `{ status: "unclean", offending: <ancestorChange>, code }`
   and the walk terminates.
4. The traversal SHALL be depth-first, visiting the root's direct
   ancestors before their transitive ancestors.
5. A cycle in `depends_on` SHALL propagate as `BriefCycleError`
   (the same error type the brief-state code raises), so callers
   that already convert cycles into a `blocked` skip handle
   cleanliness cycles identically.
6. When the underlying probe returns `disabled`, the walk SHALL
   return `{ status: "disabled" }` immediately (no further
   ancestors are checked).
7. When all visited briefs return `clean`, the result is
   `{ status: "clean" }`.

#### Scenario: Clean brief with no deps

- **WHEN** `checkBriefAndAncestorsCleanliness` is called on a
  committed brief with no `depends_on`
- **THEN** the result is `{ status: "clean" }`

#### Scenario: Unclean root brief surfaces itself

- **WHEN** `checkBriefAndAncestorsCleanliness` is called on `foo`
  whose `inputs/foo.md` is modified-but-tracked
- **THEN** the result is
  `{ status: "unclean", offending: "foo", code: " M" }`

#### Scenario: Unclean ancestor is surfaced by name

- **WHEN** `checkBriefAndAncestorsCleanliness` is called on `foo`
  whose `depends_on` includes `bar`, `inputs/foo.md` is committed,
  and `inputs/bar.md` is untracked
- **THEN** the result is
  `{ status: "unclean", offending: "bar", code: "??" }`

#### Scenario: First unclean ancestor by topological proximity wins

- **WHEN** `foo` depends on `bar`, `bar` depends on `baz`, both
  `bar` and `baz` are unclean, and `inputs/foo.md` is clean
- **THEN** the result names `bar` (the direct ancestor) as
  `offending`, not `baz`

#### Scenario: Sentinel deps are ignored

- **WHEN** `checkBriefAndAncestorsCleanliness` is called on `foo`
  whose `depends_on` includes `callback-status-signaling-design-pending`
  (a sentinel for which no `inputs/callback-status-signaling-design-pending.md`
  file exists)
- **THEN** the sentinel is skipped (no probe attempted) and, if
  the remaining graph is clean, the result is `{ status: "clean" }`

#### Scenario: Disabled gate short-circuits the walk

- **WHEN** `checkBriefAndAncestorsCleanliness` is called and the
  underlying probe returns `disabled`
- **THEN** the result is `{ status: "disabled" }`, and no further
  ancestors are probed

#### Scenario: Cycle in depends_on propagates BriefCycleError

- **WHEN** `checkBriefAndAncestorsCleanliness` is called on `foo`
  whose `depends_on` includes `bar`, and `bar`'s `depends_on`
  includes `foo`
- **THEN** the call rejects with `BriefCycleError` naming the
  cycle; the scheduler converts this to a `blocked` skip via the
  existing state-machine path

