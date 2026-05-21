## ADDED Requirements

### Requirement: Symlink-tolerant main-module guard

The CLI's main-module guard SHALL recognize the script as the
entrypoint regardless of whether `process.argv[1]` is the realpath of
the script or a symlink that resolves to it. Specifically, when
`minifac` is invoked through any symlink-based entrypoint — including
but not limited to `npm link`, a global install (`npm install -g`),
or `npx minifac` — the CLI SHALL execute `runCli` and produce output
identical to a direct invocation of the underlying compiled script
(e.g. `node ./dist/cli.js`).

The guard SHALL NOT throw if `process.argv[1]` is absent (e.g.
`node -e "..."`) or cannot be resolved on disk; in those cases the
guard SHALL evaluate to "not the entrypoint" and `runCli` SHALL NOT
run.

#### Scenario: Symlinked entrypoint runs the CLI

- **GIVEN** a symlink on `$PATH` (created by `npm link`, a global
  install, or any equivalent mechanism) pointing at the compiled
  `dist/cli.js`
- **WHEN** the user invokes `minifac --help` through that symlink
- **THEN** the CLI executes `runCli`, writes the same help output to
  stdout that a direct `node ./dist/cli.js --help` invocation
  produces, and exits with the same exit code (`0`)

#### Scenario: Direct invocation continues to run the CLI

- **GIVEN** a built `dist/cli.js`
- **WHEN** the user invokes `node ./dist/cli.js --help` directly (no
  symlink)
- **THEN** the CLI executes `runCli` and writes help output to stdout
  exactly as before this change

#### Scenario: `node -e` does not trigger `runCli`

- **GIVEN** a `node -e "import('./dist/cli.js')"` invocation in which
  `process.argv[1]` is absent or refers to a script other than
  `dist/cli.js`
- **WHEN** the top-level module of `dist/cli.js` is evaluated as a
  side effect of the import
- **THEN** the main-module guard evaluates to `false`, `runCli` does
  NOT run, and no resolution error is thrown from the guard
