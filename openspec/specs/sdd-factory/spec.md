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
expected to drive, and the status signal. Prompt text is
implementation; the contract is the spec.

The status signal for every SDD node SHALL be the `MINIFAC_STATUS`
sentinel parsed by the `claude` executor (see `node-executor` spec,
"Status signaling via sentinel marker"). The node's prompt SHALL
instruct the model to end its final assistant text with one of:

- `MINIFAC_STATUS: succeeded` — when the per-node contract is
  satisfied, or
- `MINIFAC_STATUS: failed` followed on the next line by
  `REASON: <single-line description>` — when the contract cannot be
  satisfied.

Exit codes are not part of the SDD factory contract. The executor's
exit-code fallback (per `node-executor`) remains the safety net for
sessions that crash before emitting a final assistant message, but
the factory does not rely on it.

- `propose` SHALL produce a complete OpenSpec change proposal under
  `openspec/changes/<name>/` (proposal, design, spec deltas, tasks)
  and SHALL drive `openspec validate <name>` to a clean exit before
  emitting `MINIFAC_STATUS: succeeded`.
- `apply` SHALL implement the unchecked tasks in
  `openspec/changes/<name>/tasks.md`, marking each as done, and SHALL
  emit `MINIFAC_STATUS: succeeded` only when every checkbox is
  `- [x]`.
- `verify` SHALL run the target repo's verify commands (e.g. tests,
  build, lint) in the resolved `cwd`. `verify` SHALL emit
  `MINIFAC_STATUS: succeeded` only when every verify command exits
  zero, and `MINIFAC_STATUS: failed` (with a `REASON:` naming the
  failing command) otherwise.
- `archive` SHALL drive `openspec archive <name>`. On a clean exit
  from `openspec archive`, `archive` SHALL stage and commit the
  resulting file moves and spec folds in the resolved `cwd` with a
  subject line of the form `Archive: <name>` before emitting
  `MINIFAC_STATUS: succeeded`. If `openspec archive` exits non-zero,
  `archive` SHALL NOT attempt the commit and SHALL emit
  `MINIFAC_STATUS: failed`. If the commit itself fails (for
  example, a pre-commit hook in the target repo rejects it),
  `archive` SHALL emit `MINIFAC_STATUS: failed` with a `REASON:`
  line naming the commit failure. `archive` is terminal; its
  success terminates the run.

#### Scenario: Verify failure routes back to apply within budget

- **WHEN** `verify` emits `MINIFAC_STATUS: failed` and the
  `verify → apply` edge has remaining traversals
- **THEN** the runner schedules `apply` for another iteration, and
  `apply`'s `ctx.history` contains `verify`'s failure output
  including the captured sentinel reason

#### Scenario: Budget exhaustion ends the run as failed

- **WHEN** `verify` has emitted `MINIFAC_STATUS: failed` and the
  `verify → apply` edge has been traversed 3 times already
- **THEN** the runner does not schedule a 4th `apply` iteration; the
  run ends with status `failed` and a reason citing the exhausted
  `verify → apply` budget

#### Scenario: Archive success terminates the run

- **WHEN** `archive` emits `MINIFAC_STATUS: succeeded`
- **THEN** the run ends with status `succeeded` regardless of any
  remaining schedulable work

#### Scenario: Sentinel-succeeded overrides a non-zero CLI exit

- **WHEN** any SDD node's spawned `claude` CLI exits non-zero but
  its final assistant text ends with `MINIFAC_STATUS: succeeded`
- **THEN** the runner records the node as `succeeded` (per the
  `node-executor` sentinel precedence) and edge routing proceeds
  along `on_success`

#### Scenario: Sentinel-failed overrides a zero CLI exit

- **WHEN** any SDD node's spawned `claude` CLI exits 0 but its
  final assistant text ends with `MINIFAC_STATUS: failed\nREASON: ...`
- **THEN** the runner records the node as `failed` and edge routing
  proceeds along `on_failure` (for `verify`) or ends the run as
  `failed` (for `propose`, `apply`, `archive`, which have no
  `on_failure` edge)

#### Scenario: Archive commits after openspec archive succeeds

- **WHEN** the `archive` node runs `openspec archive <name>` and
  the command exits 0, leaving the resulting moves and spec folds
  staged-but-uncommitted in `cwd`
- **THEN** the node SHALL run `git add` and `git commit` (with a
  subject line of the form `Archive: <name>`) before emitting
  `MINIFAC_STATUS: succeeded`, and the working tree in `cwd` SHALL
  be clean of the archive-produced diff after the node returns

#### Scenario: Archive commit failure surfaces as a node failure

- **WHEN** the `archive` node runs `openspec archive <name>`
  cleanly but the subsequent `git commit` exits non-zero (for
  example, a pre-commit hook in `cwd` rejects the commit)
- **THEN** the node SHALL emit `MINIFAC_STATUS: failed` followed by
  a `REASON:` line that names the commit failure, and SHALL NOT
  emit `MINIFAC_STATUS: succeeded`

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

### Requirement: SDD factory nodes opt into claude executor authority controls

Every node in the shipped SDD factory SHALL declare
`permission_mode: "bypass_permissions"` in its `with:` block. The
factory grants each spawned `claude` session full authority inside
its resolved `cwd`.

The security posture SHALL be documented as user-trust-cwd: the user
who invokes `minifac run` on this factory has explicitly chosen the
target `cwd` and accepts that the spawned sessions may write, edit,
and run side-effecting Bash inside it. The shipped prompts ship in
this repository and are readable before invocation; there is no
remote prompt-injection vector.

The factory SHALL NOT declare `allowed_tools` or `add_dirs` on any
node. Under `bypass_permissions`, `allowed_tools` is redundant
(every tool is granted) and `add_dirs` is unnecessary (nodes operate
in `cwd`).

A future relaxation to `accept_edits` or stricter modes is permitted
on user-copied factories but is out of scope for the shipped
template; lowering the posture requires the copier to also supply an
`allowed_tools` allowlist appropriate to their target repo.

#### Scenario: Each node sets permission_mode

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** every node in `factory.nodes` has
  `with.permission_mode === "bypass_permissions"`

#### Scenario: No node sets allowed_tools or add_dirs

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** no node in `factory.nodes` declares `allowed_tools` or
  `add_dirs` in its `with:` block

#### Scenario: Shipping the factory without the authority field violates the spec

- **WHEN** a contributor edits `examples/sdd.yaml` and removes
  `permission_mode` from any one of `propose`, `apply`, `verify`,
  or `archive`
- **THEN** the spec is violated and the structural test in
  `src/factory/sdd-example.test.ts` fails

### Requirement: SDD factory prompts instruct the model to emit MINIFAC_STATUS

Each of the four shipped SDD node prompts SHALL declare, in prose,
what success and failure mean for that node — the per-node
*criteria*. The mechanics of how the model communicates that outcome
(the `MINIFAC_STATUS:` sentinel format, where it must appear, and
that it must be the last thing in the message) SHALL NOT be
re-stated in the YAML prompt; per the `node-executor` capability the
`claude` executor auto-injects those mechanics into every prompt it
sends.

Concretely, each shipped prompt SHALL describe its own success and
failure semantics so the model knows what to report:

- `propose`: success means `openspec validate <name>` exits 0 and the
  required artifacts (proposal, design, spec deltas, tasks) are on
  disk; failure means validate stays dirty or a required artifact
  cannot be written.
- `apply`: success means every task in
  `openspec/changes/<name>/tasks.md` is checked `- [x]`; failure
  means a task is structurally blocked.
- `verify`: success means every verify command exits 0; failure
  means any verify command exits non-zero. The prompt SHALL further
  instruct that on failure, the `REASON:` line accompanying the
  sentinel must name the failing command and the diagnosable output,
  because that text is what the next `apply` iteration reads from
  `ctx.history`.
- `archive`: success means `openspec archive <name>` exits 0 AND the
  subsequent `git commit` exits 0; failure means either step exits
  non-zero.

The prompts SHALL NOT instruct the model to influence the CLI exit
code as the primary status signal. Exit-code influence is the
executor's fallback (per `node-executor`) and is not part of the
factory's contract.

The exact wording of the criteria is implementation. The binding
contract is: each prompt makes its per-node success and failure
semantics legible, in prose, to the model.

#### Scenario: Each prompt names its success criterion

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** each of the four node prompts (`propose`, `apply`,
  `verify`, `archive`) contains prose describing the node's success
  criterion using domain language specific to that node (for
  example: `openspec validate` for `propose`; `tasks.md` checkboxes
  for `apply`; "verify command" or `npm test` for `verify`;
  `openspec archive` and `git commit` for `archive`)

#### Scenario: Verify failure prompt documents the REASON content

- **WHEN** a reader inspects the `verify` node's prompt
- **THEN** the prompt instructs the model that on failure the
  failure description must name the failing verify command and its
  relevant output, so the next `apply` iteration receives a
  diagnosable failure description in `ctx.history`

#### Scenario: Prompts no longer carry the sentinel mechanics boilerplate

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** no node's prompt contains a `## Status signaling`
  section, no node's prompt re-states the canonical sentinel regex,
  and the literal substring `MINIFAC_STATUS` does not appear in any
  prompt — those instructions are the runner's responsibility per
  `node-executor`

