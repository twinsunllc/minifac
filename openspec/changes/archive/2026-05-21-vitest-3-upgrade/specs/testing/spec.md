## ADDED Requirements

### Requirement: Test runner is vitest, minimum major 3

The repository SHALL use `vitest` as its sole test runner. The
`devDependencies` entry for `vitest` MUST be a semver range that
admits version 3.0.0 or later and MUST NOT admit any version
below 3.0.0.

The choice of runner and the floor major version are
load-bearing decisions; changing either (e.g. flipping to
`node:test`, dropping the floor to admit 2.x again, or raising
the floor to 4.x) SHALL go through a new OpenSpec change that
MODIFIES this requirement.

#### Scenario: package.json declares a vitest ^3 range

- **WHEN** an engineer reads `package.json`
- **THEN** `devDependencies.vitest` is a semver range whose
  lower bound is `>= 3.0.0` (e.g. `^3.0.0`, `^3.1.2`, `~3.2.0`)
- **AND** the range does not admit any 2.x or earlier release

#### Scenario: installed vitest is on the 3.x line

- **WHEN** an engineer runs `npx vitest --version`
- **THEN** the reported version starts with `3.`

#### Scenario: a future bump to vitest 4 is proposed

- **WHEN** an engineer wants to raise the floor to vitest 4.x
- **THEN** they open an OpenSpec change that MODIFIES this
  requirement to state the new floor
- **AND** they update the range in `package.json` in the same
  change

### Requirement: Default test pool is `threads`; `forks` is a targeted opt-out

The repository SHALL run vitest with its default pool
(`threads` as of vitest 3.x). `vitest.config.ts` MUST NOT set a
top-level `pool: 'forks'` that applies to the whole suite.

A specific test suite that genuinely cannot tolerate the
`threads` pool MAY opt out to `pool: 'forks'` via a targeted
mechanism (e.g. `poolMatchGlobs`, a per-file `pool` directive,
or an equivalent vitest-supported scoping). The opt-out MUST be
justified by a comment naming the per-process state the suite
mutates (e.g. `process.cwd`, `process.env`, a module-level
singleton) and MUST NOT be a precautionary "just in case"
escape hatch.

#### Scenario: vitest.config.ts has no global forks override

- **WHEN** an engineer reads `vitest.config.ts`
- **THEN** no top-level `pool: 'forks'` key applies to the
  whole suite
- **AND** any pool override is scoped to a specific glob, file,
  or suite

#### Scenario: a suite mutates process.cwd and needs forks

- **WHEN** a test suite mutates `process.cwd` and the mutation
  cannot be cleanly undone between tests
- **THEN** the engineer SHALL either (a) repair the suite to
  push/pop the working directory around each test, or (b)
  opt that one suite into `pool: 'forks'` via a targeted
  `poolMatchGlobs` (or equivalent) entry with a comment naming
  the state mutation that justifies the opt-out

#### Scenario: a contributor proposes flipping the global default to forks

- **WHEN** a contributor proposes setting a top-level
  `pool: 'forks'` in `vitest.config.ts`
- **THEN** the change SHALL go through an OpenSpec change that
  MODIFIES this requirement, since the policy ("threads default,
  targeted forks only") is the contract

### Requirement: Dev-chain audit findings on the test runner are resolved, not allowlisted

The project SHALL resolve audit findings rooted in the test-runner
dev chain (vitest → vite → esbuild, or any future equivalent) by
bumping the relevant dev dependency, and MUST NOT add `npm audit`
allowlist entries that suppress the findings instead.

This requirement is policy-level: it does not enumerate
specific CVEs, only the response posture. It mirrors the
disposition recorded in `docs/decisions/0024-CI-Security-Policy.md`
and `docs/decisions/0025-Vitest-3-Upgrade.md`.

#### Scenario: a new moderate-severity finding lands in the vitest chain

- **WHEN** `npm audit` reports a moderate or higher finding
  rooted in the vitest/vite/esbuild dev chain
- **THEN** the response SHALL be to bump the relevant dev
  dependency to a patched version (subject to the dep-freshness
  cooldown gate)
- **AND** the response SHALL NOT be to add an `npm audit`
  allowlist entry that suppresses the finding

#### Scenario: a finding cannot yet be bumped away

- **WHEN** no patched version is available within the
  dep-freshness cooldown window
- **THEN** the residual finding MAY be tolerated temporarily,
  but MUST be named (CVE id or advisory id) in the relevant
  commit message or follow-up issue, with a written cleanup
  trigger (e.g. "remove when vitest 3.x.y lands")
- **AND** the residual MUST NOT be added to a permanent
  allowlist
