# sdd-factory Specification

## Purpose
TBD - created by archiving change sdd-factory. Update Purpose after archive.
## Requirements
### Requirement: SDD example factory ships in the repo

The repository SHALL ship a canonical SDD example factory at
`examples/sdd.yaml` that loads, validates, and is runnable end-to-end
against an OpenSpec-equipped target repo using only v0 facilities
(the `claude` executor and per-node `cwd`). The factory SHALL require
no new executors, no new schema fields, and no new runner features
beyond those documented in the canonical `factory-schema`,
`graph-runner`, `node-executor`, and `run-cli` specs.

#### Scenario: Factory loads via the existing loader

- **WHEN** `loadFactory("examples/sdd.yaml")` is invoked
- **THEN** the loader returns a typed factory object without error

#### Scenario: Factory uses only the claude executor

- **WHEN** the factory is loaded
- **THEN** every node has `executor: claude`

### Requirement: SDD factory topology

The factory SHALL contain exactly four nodes named `propose`, `apply`,
`verify`, and `archive`. The edges SHALL be exactly: `propose → apply`
(default `on_success`), `apply → verify` (default `on_success`),
`verify → archive` (default `on_success`), and `verify → apply` with
`when: "on_failure"`. The `archive` node SHALL be the sole node with
`terminal: true`.

#### Scenario: Nodes match the documented set

- **WHEN** the factory is loaded
- **THEN** the node ids are exactly `{propose, apply, verify, archive}`

#### Scenario: Edges match the documented set

- **WHEN** the factory is loaded
- **THEN** the edges are exactly:
  - `propose → apply` (`on_success` default)
  - `apply → verify` (`on_success` default)
  - `verify → archive` (`on_success` default)
  - `verify → apply` with `when: "on_failure"`

#### Scenario: Archive is the only terminal node

- **WHEN** the factory is loaded
- **THEN** `archive.terminal === true` and no other node has
  `terminal: true`

### Requirement: SDD factory has a single start node

The `propose` node SHALL be the only start node of the factory.
`propose` SHALL have no inbound edges, ensuring per the
`graph-runner` spec that it is the unique entry to forward flow.

#### Scenario: Loader resolves propose as the start node

- **WHEN** the factory is loaded and start nodes are resolved
- **THEN** the resolved start-node set is exactly `{propose}`

### Requirement: SDD factory bounds the verify→apply retry cycle

The `verify → apply` edge SHALL carry `max_traversals: 3`. No other
edge SHALL carry a `max_traversals` budget, and no node SHALL carry a
`max_iterations` budget. The single cycle `apply → verify → apply`
SHALL be covered by the edge budget, satisfying the
`factory-schema` requirement that cycles be bounded by construction.

#### Scenario: Verify-to-apply edge is bounded

- **WHEN** the factory is loaded
- **THEN** the `verify → apply` edge has `max_traversals === 3`

#### Scenario: No other budgets are declared

- **WHEN** the factory is loaded
- **THEN** no other edge carries `max_traversals` and no node carries
  `max_iterations`

### Requirement: SDD factory per-node responsibility

Each node SHALL fulfill a documented per-node contract. The contract
binds the responsibility, the OpenSpec CLI command(s) the node is
expected to drive, and the exit-status signal. Prompt text is
implementation; the contract is the spec.

- `propose` SHALL produce a complete OpenSpec change proposal under
  `openspec/changes/<name>/` (proposal, design, spec deltas, tasks)
  and SHALL drive `openspec validate <name>` to a clean exit before
  emitting a `succeeded` status.
- `apply` SHALL implement the unchecked tasks in
  `openspec/changes/<name>/tasks.md`, marking each as done, and SHALL
  emit `succeeded` only when every checkbox is `- [x]`.
- `verify` SHALL run the target repo's verify commands (e.g. tests,
  build, lint) in the resolved `cwd`. `verify` SHALL emit `succeeded`
  only when every verify command exits zero, and `failed` otherwise.
- `archive` SHALL drive `openspec archive <name>` and emit
  `succeeded` only on a clean exit. `archive` is terminal; its
  success terminates the run.

#### Scenario: Verify failure routes back to apply within budget

- **WHEN** `verify` emits a `failed` status and the `verify → apply`
  edge has remaining traversals
- **THEN** the runner schedules `apply` for another iteration, and
  `apply`'s `ctx.history` contains `verify`'s failure output

#### Scenario: Budget exhaustion ends the run as failed

- **WHEN** `verify` has failed and the `verify → apply` edge has been
  traversed 3 times already
- **THEN** the runner does not schedule a 4th `apply` iteration; the
  run ends with status `failed` and a reason citing the exhausted
  `verify → apply` budget

#### Scenario: Archive success terminates the run

- **WHEN** `archive` emits a `succeeded` status
- **THEN** the run ends with status `succeeded` regardless of any
  remaining schedulable work

### Requirement: SDD factory ships per-node documentation

The repository SHALL ship `examples/sdd.md` alongside `examples/sdd.yaml`
documenting each node's contract in human-readable form, including
which fields a user is expected to edit when copying the factory for a
new change (at minimum: the change name referenced in each node's
prompt, and the `cwd` for each node).

#### Scenario: Per-node documentation exists

- **WHEN** the repository is inspected
- **THEN** `examples/sdd.md` exists and documents the contract for
  each of `propose`, `apply`, `verify`, and `archive`

### Requirement: SDD factory is the documented template, not a runnable singleton

The shipped `examples/sdd.yaml` SHALL be documented as a template
that users copy and edit per change. Users SHALL be expected to copy
the file (e.g. to `sdd-<changename>.yaml`) and edit (a) the change
name embedded in each node's prompt and (b) the `cwd` for each node
before running. The documentation SHALL state explicitly that
running the shipped file unedited is not the intended workflow.

#### Scenario: README points users to the copy-and-edit workflow

- **WHEN** a user reads `README.md`'s "Run the example" section
- **THEN** the section references `examples/sdd.yaml`, names the two
  fields that must be edited (change name in prompts, per-node
  `cwd`), and links to `examples/sdd.md` for details

