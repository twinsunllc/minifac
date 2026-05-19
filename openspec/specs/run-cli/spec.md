# run-cli Specification

## Purpose
TBD - created by archiving change core-graph-runner. Update Purpose after archive.
## Requirements
### Requirement: `minifac run` command

The CLI SHALL expose a `run` subcommand that takes a single positional
argument: the path to a factory YAML file. It SHALL load and validate
the factory, then execute it using the in-process runner, streaming node
events to the terminal.

#### Scenario: Valid factory runs end-to-end

- **WHEN** the user invokes `minifac run hello.yaml` against the shipped
  example factory
- **THEN** the CLI loads the factory, executes the single Claude node,
  streams its output, and exits with code 0

#### Scenario: Missing file fails with a usage error

- **WHEN** the user invokes `minifac run nonexistent.yaml`
- **THEN** the CLI writes an error to stderr naming the missing file and
  exits with code 1

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

