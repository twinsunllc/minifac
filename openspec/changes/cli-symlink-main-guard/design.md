## Context

`src/cli.ts` is shipped as the `bin` entry for the `minifac` package.
When the package is consumed via `npm link`, `npm install -g`, or
`npx`, the package manager creates a symlink on `$PATH` (e.g.
`/usr/local/bin/minifac`) pointing at the realpath of `dist/cli.js`
inside the linked package directory.

Node's ESM loader, given a symlink as the entrypoint, resolves
`import.meta.url` through the symlink and returns the realpath. It
does **not** rewrite `process.argv[1]`; that retains the path the user
(or shell) actually passed. So in a symlinked invocation:

- `fileURLToPath(import.meta.url)` → realpath of `dist/cli.js`
- `process.argv[1]` → the symlink path on `$PATH`

The existing strict-equality guard compares those two and decides the
script is not the entrypoint, so `runCli()` is skipped. The top-level
imports (which include `node:sqlite`) still execute, printing the
`ExperimentalWarning`, and then the process exits cleanly with no
observable behavior. The failure mode is invisible.

ADR
[`docs/decisions/0023-CLI-Symlink-Main-Guard.md`](../../../docs/decisions/0023-CLI-Symlink-Main-Guard.md)
locks the design call: compare realpaths.

## Goals / Non-Goals

**Goals:**

- Make `minifac` invoked through a symlink behave identically to
  `node ./dist/cli.js` invoked directly.
- Cover the symlink invocation path with an automated regression test
  that exercises the **compiled** artifact (so the bug, which only
  manifests in the shipped form, is actually reproduced).
- Keep the patch minimal: one guard, one test. No refactor of
  `cli.ts`, no new module, no new build step.

**Non-Goals:**

- Switching the canonical install path from `npm link` to
  `npm publish` / `npx minifac`. That belongs to a separate
  open-source-readiness change.
- Adding a CJS bin shim that re-execs the ESM module.
- Restructuring `src/cli.ts`. The guard at the bottom stays in place;
  only its comparison is updated.
- Auditing every other `import.meta.url` / `process.argv[1]` site in
  the repo — none currently exist, and adding a generic helper is
  premature for a one-line fix.

## Decisions

### Decision: Compare realpaths

The guard SHALL resolve `process.argv[1]` through `realpathSync`
before comparing it to the realpath that
`fileURLToPath(import.meta.url)` already returns. Concretely:

```ts
import { realpathSync } from "node:fs";
// ... existing imports ...

const isMain = (() => {
  try {
    const here = fileURLToPath(import.meta.url);
    const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
    return here === invoked;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(/* ... */);
}
```

**What we considered:**

- **Drop the guard entirely.** `cli.js` is bin-only; nothing imports
  it as a library today. Removing the guard would also fix the bug.
  Rejected because the realpath comparison is a one-line change that
  remains defensive against future test-harness or "import for
  inspection" use cases, and matches the ADR.
- **Use `require.main` / `process.mainModule`.** Both are legacy /
  unavailable in ESM. The file is `type: module`; neither API is on
  the menu.
- **CJS bin shim that re-execs the ESM.** Overkill for a one-line
  fix; also adds a maintenance surface.
- **Conditionally `realpathSync` only when `argv[1]` differs from
  `here`.** Pointless micro-optimization; we always need to resolve
  to know.

**Edge cases:**

- `process.argv[1]` missing (e.g. `node -e "..."`) — fall back to
  `""` so the comparison fails and `isMain` is `false`. That is the
  correct answer for `-e`/`-p`/`--eval` flows: the script file is not
  the entrypoint.
- `realpathSync` throws (e.g. `process.argv[1]` points at a path that
  no longer exists by the time we resolve it) — the existing
  `try/catch` around the guard already catches and returns `false`.
  Both `fileURLToPath` and `realpathSync` are inside the same `try`.
- Windows path casing / drive-letter normalization — Node's
  `realpathSync` returns the canonical form on both sides, so the
  string comparison continues to work.

### Decision: Regression test exercises the compiled artifact

The regression test SHALL:

1. Ensure `dist/cli.js` exists (build first if necessary).
2. Create a temp directory.
3. Create a symlink inside the temp directory pointing at the
   absolute path of `dist/cli.js`.
4. Spawn `node <symlink> --help` as a subprocess.
5. Assert exit code is `0` and stdout contains the help banner that
   `runCli` produces (e.g. the `Usage: minifac` header).

**Why subprocess, not unit-level:**

- The bug only manifests in Node's actual ESM loader resolution of an
  entrypoint that is a symlink. Mocking `import.meta.url` and
  `process.argv[1]` against an extracted helper would test the
  helper's logic, not the integration we actually care about (that
  `runCli` runs when invoked through the symlink).
- A subprocess test against the compiled output catches future
  regressions where the guard is restructured but breaks on a
  different platform / Node version.

**Why we still keep it small:**

- One test, in `src/cli.test.ts` (or a sibling), using
  `node:child_process` `spawnSync`.
- Uses `node:fs` `symlinkSync` and `mkdtempSync`. Cleanup via
  `rmSync(..., { recursive: true, force: true })` in `afterEach`.
- Skips with a clear message if `dist/cli.js` doesn't exist (the
  test should run after build in CI; local dev runs `npm run build`
  before tests anyway).

### Decision: No source-side test for the unsymlinked direct invocation

The existing direct-invocation case (`node ./dist/cli.js --help`) is
already covered by the broader CLI test suite. Adding a parallel
"unsymlinked" subprocess test would just retest the same path. The
new test is specifically for the symlink case.

## Risks / Trade-offs

- **One extra syscall at startup.** `realpathSync` is a stat-chain
  walk; on modern filesystems it is sub-millisecond and runs once.
  Acceptable.
- **Test depends on `dist/`.** If the project ever changes its build
  layout (e.g. ESM bundling that emits a different filename), the
  test needs the matching update. This is the same coupling every
  end-to-end test of the bin entry already has; not new surface.
- **`node:sqlite` ExperimentalWarning still prints** even with the
  guard fixed. The warning is unrelated to this change and is
  emitted by the top-level imports regardless of whether `runCli`
  runs. Out of scope here.

## Migration Plan

None. The change is a single-call-site fix to a guard that was
already in place. No data, no API, no user-facing surface changes
beyond the bug going away.

## Open Questions

- Is there value in also resolving `import.meta.url` through
  `realpathSync` defensively? Node already returns a realpath for
  ESM entrypoint URLs, but a future Node release could theoretically
  change. **Resolution:** leave it. The ADR specifies resolving
  `argv[1]`, which is the only side that currently disagrees;
  defending against a hypothetical future Node regression is
  speculative.
