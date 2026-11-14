## Why

Scarif orders may now name a `start_branch` apart from their `base_branch`
(SCARIFW-3040, retro 11-14 P4): `start_branch` is where the droid's working
branch is cut from, `base_branch` is where the PR goes. The worker writes the
value into the brief it hands minifac, but `{{ brief.start_branch }}` rendered
verbatim, because `substitute.ts` resolved only `change`, `factory`, `body`,
`base_branch` and `model`. A library step (SCARIFW-3041) needs to name it.

## What Changes

- **ADDED** `graph-runner` "Brief start_branch token": `{{ brief.start_branch }}`
  substitutes the brief frontmatter's `start_branch` when present, and the
  empty string when absent (the `brief.base_branch` convention), never the
  token verbatim.
- `BriefFrontmatterSchema` gains an optional `start_branch` string.

## Impact

- `src/brief/schema.ts`, `src/runner/substitute.ts`,
  `src/runner/substitute.test.ts`.
- Inert unless a step's prompt or binding uses `{{ brief.start_branch }}`.
