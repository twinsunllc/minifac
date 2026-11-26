## Why

The captain's ruling in case `scarif:factory-tilde-pins` (2026-11-26), recorded
in scarif-spec's change `factory-library-pin-ranges` (scarif-spec#804), lets a
factory's `factory.yaml` declare `library.range`, a pessimistic constraint
`~> MAJOR.MINOR`, beside the exact `library.ref` lock. Scarif's droid preflight
(SCARIFW-3294) reads the pin through minifac's loader, and the loader refuses
any `library:` key other than `repo` and `ref`, as "A project declares at most
one library, pinned" requires. Without this change every factory that declares
`range` fails to load with "unknown key(s): range", whether or not its lock is
in range.

## What Changes

- **MODIFIED** `library-resolution` "A project declares at most one library,
  pinned": `library:` carries `repo` and `ref` and MAY carry `range`, a
  non-empty string the loader does not interpret. A `range` that is not a
  non-empty string is a load error naming the file. Any other key is still a
  load error. The library is still resolved and fetched at `ref` only.
- `LibraryDeclaration` gains an optional `range`, carried verbatim.

Judging `ref` against `range` is not the loader's job: Scarif's droid
preflight (scarif-worker) does it before it loads the factory.

## Impact

- `src/library/library.ts`, `src/library/library.test.ts`, `README.md`,
  `CHANGELOG.md`.
- Inert unless a project declares `library.range`.
