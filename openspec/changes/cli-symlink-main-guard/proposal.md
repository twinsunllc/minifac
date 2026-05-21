## Why

`minifac` installed via `npm link` (or any symlink-based global install
path, including `npx`) is a silent no-op: the process starts, the
`node:sqlite` ExperimentalWarning prints to stderr, and the process
exits `0` with no output. No error, no stack, no usage message.

The cause is the main-module guard at the bottom of `src/cli.ts`:

```ts
const here = fileURLToPath(import.meta.url);
if (here === process.argv[1]) {
  runCli();
}
```

When invoked through a symlink, Node resolves `import.meta.url` to the
**realpath** of the script but leaves `process.argv[1]` as the
**symlink path**. The strict `===` always fails. `runCli()` is never
called.

The binding decision is captured in
`docs/decisions/0023-CLI-Symlink-Main-Guard.md`: compare realpaths.

This bug blocks the canonical install story (`npm publish` / `npx
minifac`) we want to promote in the open-source-readiness work — that
pitch is not honest while a symlink invocation silently does nothing.

## What Changes

- **Fix the guard in `src/cli.ts`.** Resolve `process.argv[1]` through
  `realpathSync` before comparing it to the realpath that
  `fileURLToPath(import.meta.url)` already returns. Handle the
  no-`argv[1]` case (e.g. `node -e`) by falling back to a value that
  cannot match the realpath, so the guard remains `false` there.
- **Add a regression test** that invokes the compiled `dist/cli.js`
  through a symlink in a temp directory and asserts the CLI runs
  (e.g. `--help` produces the normal help output on stdout, exit
  code `0`).
- **No changes to `runCli` itself**, no restructure of `src/cli.ts`
  beyond the guard, no CJS bin shim, no install-path migration.

## Impact

- Affected specs: `run-cli` (ADDED requirement covering symlink
  invocation parity).
- Affected code: `src/cli.ts` (guard only) and a new test that
  exercises the compiled `dist/cli.js` through a symlink.
- Affected install paths: `npm link`, global `npm install -g`, and
  `npx minifac` all stop being silent no-ops.
- Negligible runtime cost: one extra `realpathSync` call at process
  start, dropped after the guard runs.
