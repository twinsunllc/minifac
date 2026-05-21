---
change: cli-symlink-main-guard
factory: sdd
base_branch: main
---

## Background

`minifac` installed via `npm link` (or any symlink-based global
install path) is a silent no-op: top-level imports run, the
`node:sqlite` ExperimentalWarning prints to stderr, and the
process exits 0 with no output.

The root cause is the `isMain` guard in `src/cli.ts` at the
bottom of the file:

```ts
const here = fileURLToPath(import.meta.url);
if (here === process.argv[1]) {
  runCli();
}
```

When invoked through a symlink, Node resolves `import.meta.url`
to the **realpath** of the script but leaves `process.argv[1]`
as the **symlink path**. The strict `===` always fails. The CLI
never runs.

The binding decision is at
`docs/decisions/0023-CLI-Symlink-Main-Guard.md`. Read it first.
The locked design call: compare realpaths.

## What to do

### 1. Fix the guard

In `src/cli.ts`, replace the existing strict-path comparison
with a realpath-tolerant one. Sketch:

```ts
import { realpathSync } from "node:fs";

// ... existing code ...

const here = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
const isMain = here === invoked;
if (isMain) {
  runCli();
}
```

- `realpathSync` runs once at startup; the cost is negligible.
- The `process.argv[1] ? ... : ""` guard handles the `node -e`
  / no-argv1 case without throwing.

### 2. Regression test

Add a test that simulates symlink invocation. Options:

- **Subprocess test** (preferred): in a tmp dir, create a symlink
  pointing at `dist/cli.js`, then spawn `node <symlink> --help`
  and assert the help output appears on stdout. This catches
  the exact bug we hit.
- If subprocess tests are too heavyweight for this surface, a
  unit-level test that imports a small extracted `isMainModule`
  helper and feeds it mocked `importMetaUrl` + `argv1` pairs
  (real path vs symlink path) is also acceptable.

Run the test against pre-fix code to confirm it fails for the
right reason, then against the fix to confirm it passes.

### 3. Build & rebuild

The fix lives in source; `dist/cli.js` is generated. Make sure
`npm run build` produces a new `dist/cli.js` and the test runs
against compiled output where possible (so it actually exercises
the shipped artifact).

### 4. Manual smoke (document it)

In the brief's apply phase, do **not** run `npm link` yourself
— the user already has the link in place. After the fix lands,
the user can re-run `npm run build` and verify
`minifac --help` produces output. Note this in the spec /
acceptance section but don't try to automate the link step.

### 5. Docs

- README quickstart, if it shows `npm link` as an install option,
  is now honest. Update only if the existing copy is
  misleading.
- Roadmap's "Open-source readiness" section mentions
  `npm publish` + `npx minifac` as the canonical install path;
  this bug had to die first. No Roadmap change required —
  this brief landing is the change.

### 6. Specs

`run-cli` (or whichever spec covers CLI invocation): ADDED
requirement that `minifac` invoked via a symlink (e.g.,
`npm link`, `npx`, global install) calls `runCli()` and produces
output identical to direct `node dist/cli.js` invocation. Scenario
covers the symlink-invocation path.

When MODIFYING an existing requirement block, copy the entire
block; do not partial-paste.

## Out of scope

- Switching from `npm link` to `npm publish` as the canonical
  install path
- A CJS bin shim
- Any restructuring of `src/cli.ts` beyond the guard

## Acceptance criteria

- `minifac --help` (with `minifac` resolved through an
  `npm link` symlink) prints the same help output as
  `node ./dist/cli.js --help`
- New regression test covers the symlink invocation path
- All existing tests pass
- Build clean; biome clean
