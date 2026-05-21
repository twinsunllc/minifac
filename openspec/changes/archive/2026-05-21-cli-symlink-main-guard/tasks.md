## 1. Fix the main-module guard

- [x] 1.1 Add `import { realpathSync } from "node:fs";` to `src/cli.ts`
  (next to the existing `node:url` import).
- [x] 1.2 Update the `isMain` IIFE at the bottom of `src/cli.ts` to
  resolve `process.argv[1]` via `realpathSync` before comparing it to
  the realpath returned by `fileURLToPath(import.meta.url)`. Fall back
  to `""` (or any value that cannot match the realpath) when
  `process.argv[1]` is absent. Keep the surrounding `try/catch` so any
  resolution failure leaves `isMain` as `false`.

## 2. Regression test for symlink invocation

- [x] 2.1 Add a test (`src/cli.symlink.test.ts` or a new `describe`
  block in `src/cli.test.ts`) that:
  - Skips with a clear message if `dist/cli.js` does not exist.
  - Creates a temp directory with `fs.mkdtempSync`.
  - Creates a symlink (`fs.symlinkSync`) inside the temp directory
    pointing at the absolute path of `dist/cli.js`.
  - Spawns `node <symlink> --help` via `node:child_process`
    `spawnSync` and captures stdout, stderr, and exit code.
  - Asserts exit code is `0` and stdout contains the expected help
    banner (e.g. the `Usage: minifac` or equivalent string emitted by
    `runCli`).
  - Cleans the temp directory in `afterEach` / a `finally` block.
- [x] 2.2 Run the test against the **pre-fix** `dist/cli.js` once to
  confirm it fails (no help output, exit `0`) for the right reason —
  i.e. confirms the bug. Then run against the **fixed** build to
  confirm it passes.

## 3. Build and verify

- [x] 3.1 Run `npm run build` and confirm `dist/cli.js` regenerates
  cleanly.
- [x] 3.2 Run the full test suite; confirm the new test passes and no
  existing test regresses.
- [x] 3.3 Run the project's lint/format check (biome) and confirm
  clean.

## 4. Manual smoke (documentation, not automation)

- [x] 4.1 Note in the change README (and/or the test comments) that
  the human verification path is:
  `npm run build && minifac --help` (where `minifac` is on `$PATH`
  via a pre-existing `npm link`). Do **not** automate `npm link` in
  the test or as part of this change.

## 5. Spec deltas

- [x] 5.1 Spec delta under `specs/run-cli/spec.md`:
  ADD a requirement that `minifac` invoked via a symlinked entrypoint
  (e.g. `npm link`, global install, `npx`) calls `runCli()` and
  produces output identical to direct `node dist/cli.js` invocation.
  Include a scenario that covers the symlink invocation path
  end-to-end.
