# run-cli Specification

## Purpose
TBD - created by archiving change core-graph-runner. Update Purpose after archive.
## Requirements
### Requirement: `minifac run` command

The CLI SHALL expose a `run` subcommand that takes a single positional
argument `<thing>`. The CLI SHALL resolve `<thing>` to a brief, a
factory, or an error using the following lookup precedence, evaluated
in order against the directory the CLI was invoked from (cwd):

1. **Brief by path.** If `<thing>` contains a path separator OR ends
   in `.md`, treat `<thing>` as a brief path. Resolve relative paths
   against cwd, absolute paths verbatim. If the file does not exist,
   exit `1` with an error naming the resolved path.
2. **Brief by name.** Else, if `inputs/<thing>.md` exists in cwd, treat
   it as a brief by name and load it via that path.
3. **Factory by name.** Else, if `examples/<thing>.yaml` exists in
   cwd, treat the run as a brief-less factory invocation of that
   factory. (The `examples/` prefix is a v0 stopgap until
   factory-composition ships per the roadmap.)
4. **Else.** Write an error to stderr explaining that `<thing>` could
   not be resolved as a brief path, brief name, or factory name and
   exit `1`.

When a brief is resolved (steps 1 or 2), the CLI SHALL further resolve
the brief's frontmatter `factory:` field as a factory name using the
same step-3 logic (try `examples/<factory>.yaml`). A brief whose
`factory:` field does not resolve SHALL exit `1` with an error naming
the missing factory.

The CLI SHALL enforce the factory's declared brief mode (per the
`factory-schema` capability's "Factory brief-mode declaration"
requirement) before any node executes:

- `brief: "required"` invoked without a brief (step 3 resolution) →
  exit `1` with a message naming the factory and instructing the user
  to invoke with a brief.
- `brief: "none"` invoked with a brief (step 1 or 2 resolution) →
  exit `1` with a message naming the factory and the conflict.
- `brief: "optional"` → accept either invocation mode.

Direct invocation by factory YAML path (e.g. `minifac run
examples/sdd.yaml`) SHALL NOT be supported. A `.yaml` or `.yml`
extension on `<thing>` falls into step 1 (treated as a brief path),
which will fail to parse as a brief; the CLI SHALL exit `1` with the
brief-load error in that case, surfacing the misuse directly.

When resolution succeeds, the CLI SHALL load the factory, perform
factory-load validation, then invoke the runner with the factory and
(when present) the brief. The runner streams node events to the
terminal per the existing event-output requirement, which is unchanged
by this revision.

#### Scenario: Brief by path loads and runs

- **WHEN** the user invokes `minifac run inputs/foo.md` and that file
  is a valid brief whose `factory:` resolves to `examples/sdd.yaml`
- **THEN** the CLI loads the brief, loads `examples/sdd.yaml`, and
  runs the factory with the brief in scope; streaming output begins
  before the process exits

#### Scenario: Brief by bare name resolves via inputs/<name>.md

- **WHEN** the user invokes `minifac run my-change` and
  `inputs/my-change.md` exists as a valid brief
- **THEN** the CLI loads that brief, resolves its factory by name, and
  runs the factory with the brief in scope

#### Scenario: Factory by bare name runs brief-less

- **WHEN** the user invokes `minifac run hello`,
  `inputs/hello.md` does not exist, `examples/hello.yaml` exists, and
  `examples/hello.yaml` declares `brief: "none"`
- **THEN** the CLI loads `examples/hello.yaml` and runs it brief-less;
  streaming output begins before the process exits

#### Scenario: Brief takes precedence over a same-named factory

- **WHEN** both `inputs/sdd.md` and `examples/sdd.yaml` exist and the
  user invokes `minifac run sdd`
- **THEN** the CLI loads `inputs/sdd.md` (step 2) and ignores
  `examples/sdd.yaml` at the top-level lookup; the factory is then
  resolved through the brief's `factory:` field

#### Scenario: Brief-required factory invoked brief-less is rejected

- **WHEN** the user invokes `minifac run sdd`, `inputs/sdd.md` does
  not exist, and `examples/sdd.yaml` declares `brief: "required"`
- **THEN** the CLI exits `1` writing an error that names the factory
  and indicates a brief is required; no node executes

#### Scenario: Brief-none factory invoked with a brief is rejected

- **WHEN** the user invokes `minifac run hello-brief` and
  `inputs/hello-brief.md` is a brief whose `factory:` resolves to
  `examples/hello.yaml`, which declares `brief: "none"`
- **THEN** the CLI exits `1` writing an error naming the factory and
  the conflict; no node executes

#### Scenario: Direct factory-YAML path is no longer supported

- **WHEN** the user invokes `minifac run examples/sdd.yaml`
- **THEN** the CLI treats the argument as a brief path (step 1), fails
  to parse it as a brief, and exits `1` with the brief-load error

#### Scenario: Missing thing reports a clear resolution error

- **WHEN** the user invokes `minifac run nonexistent` and none of
  `nonexistent`, `inputs/nonexistent.md`, or `examples/nonexistent.yaml`
  resolves
- **THEN** the CLI writes an error to stderr explaining that
  `nonexistent` could not be resolved as a brief path, brief name, or
  factory name, and exits `1`

#### Scenario: Brief whose factory does not resolve is rejected

- **WHEN** the user invokes `minifac run inputs/foo.md`, the brief
  loads cleanly, its `factory:` field is `nonexistent`, and
  `examples/nonexistent.yaml` does not exist
- **THEN** the CLI exits `1` with an error naming the missing factory

### Requirement: Event output format

For each node event received, the CLI SHALL write a single line to
stdout (for `stdout` events) or stderr (for `stderr` events), prefixed
with `[<node_id>] ` so multiple nodes' output is legible when
interleaved. `status` events SHALL be written to stderr in a single,
distinct format that names the node and the status.

#### Scenario: Output lines carry node prefix

- **WHEN** node `propose` emits the stdout line "hello"
- **THEN** the terminal shows a line containing `[propose] hello`

#### Scenario: Status events are distinguishable from output

- **WHEN** node `propose` transitions to `succeeded`
- **THEN** stderr receives a line that identifies both the node id and
  the status, distinct in format from `stdout`/`stderr` lines

### Requirement: Exit codes

The CLI SHALL exit with:

- `0` when the run reaches a terminal node with `succeeded`
- `1` for usage errors, file-not-found, or factory load/validation errors
- `2` when a node fails and no recovery path leads to a terminal success
- `3` when budget exhaustion ends the run before reaching a terminal node

#### Scenario: Successful run exits 0

- **WHEN** a factory completes with a successful terminal node
- **THEN** the process exits with code 0

#### Scenario: Schema error exits 1

- **WHEN** the supplied factory fails schema validation
- **THEN** the process writes the validation error to stderr and exits
  with code 1

#### Scenario: Node failure exits 2

- **WHEN** every path from the failing node leads to no further
  schedulable work and no terminal node has succeeded
- **THEN** the process exits with code 2

#### Scenario: Budget exhaustion exits 3

- **WHEN** all cycle budgets are exhausted before a terminal node
  succeeds
- **THEN** the process exits with code 3

### Requirement: `--help` and `--version`

The CLI SHALL respond to `--help` (and `-h`) with a usage summary listing
available subcommands and to `--version` with the package version.

#### Scenario: Help is available without arguments

- **WHEN** the user invokes `minifac --help`
- **THEN** the CLI prints usage to stdout and exits with code 0

