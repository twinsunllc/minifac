---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0023: Symlink-tolerant `import.meta` main-module guard

## Context

`src/cli.ts` ends with a guard that calls `runCli()` only when the
file is being executed as the entrypoint:

```ts
const here = fileURLToPath(import.meta.url);
if (here === process.argv[1]) {
  runCli();
}
```

This works when minifac is invoked directly
(`node /path/to/dist/cli.js`) because both values resolve to the
same on-disk path. It silently breaks when invoked through a
symlink — which is exactly what `npm link` produces:

- `import.meta.url` resolves through the symlink and returns the
  **realpath** (`/Users/.../minifac/dist/cli.js`)
- `process.argv[1]` retains the **symlink path**
  (`/Users/.../bin/minifac`)

Strict `===` fails. `runCli()` is never called. Top-level imports
run, the `node:sqlite` ExperimentalWarning prints to stderr, and
the process exits clean with no observable behavior.

The bug is invisible: no error, no stack, no exit code — just a
silently-do-nothing CLI when installed via `npm link` (or, by
extension, any global install path that goes through a symlink,
including `npx`-style invocations and most package-manager `bin`
shims).

## Decision

Compare **realpaths** in the main-module guard. The minimal patch:

```ts
import { realpathSync } from "node:fs";
const here = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
const isMain = here === invoked;
if (isMain) {
  runCli();
}
```

`realpathSync` runs once at startup and resolves symlinks on
the `process.argv[1]` side so the comparison is meaningful.

## Consequences

- `npm link` now works as users expect. `minifac` on `$PATH`
  invokes the same CLI as `node ./dist/cli.js`.
- The `npx minifac` / global-install path stops being a silent
  no-op. This unblocks the canonical install instruction we'll
  promote in the open-source README work.
- One additional syscall at startup (negligible).
- If `process.argv[1]` doesn't exist (e.g., `node -e`), the
  fallback to `""` keeps the guard from throwing — `isMain`
  evaluates to `false`, which is the right answer there.

## Alternatives considered

- **Drop the guard entirely.** `cli.js` is bin-only; nothing
  imports it as a library. Removing the guard would also fix
  the bug. Rejected because the realpath comparison is a tiny
  one-line addition that's defensive against future test
  harness or "import for inspection" use cases.
- **Use `process.mainModule` or `require.main`.** Both are
  legacy / unavailable in ESM. The file is `type: module`;
  neither API is on the menu.
- **Switch to a CJS bin shim that re-execs the ESM.** Overkill
  for a one-line fix.

## Related

- [[Run]] — the surface the CLI exposes; this is just the
  entrypoint guard
- [[Roadmap]] — open-source-readiness chore tier mentions
  `npm publish` + canonical `npx minifac` as the install path;
  this bug had to die before that pitch was honest
