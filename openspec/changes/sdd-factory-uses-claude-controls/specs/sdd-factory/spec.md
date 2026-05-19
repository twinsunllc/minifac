## MODIFIED Requirements

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
- `archive` SHALL drive `openspec archive <name>` and emit
  `MINIFAC_STATUS: succeeded` only on a clean exit. `archive` is
  terminal; its success terminates the run.

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

## ADDED Requirements

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

Each of the four shipped SDD node prompts SHALL include explicit
instructions for the model to end its final assistant text with a
`MINIFAC_STATUS:` line. The prompt SHALL describe both the success
and failure shapes:

- Success: a single line `MINIFAC_STATUS: succeeded`.
- Failure: two lines — `MINIFAC_STATUS: failed` followed by
  `REASON: <single-line description of what blocked the node>`.

The prompts SHALL NOT instruct the model to influence the CLI exit
code as the primary status signal. Exit-code influence is the
executor's fallback (per `node-executor`) and is not part of the
factory's contract.

The exact wording of the instructions is implementation. The binding
contract is: each prompt makes the sentinel emission explicit, and
each prompt contains the literal substring `MINIFAC_STATUS`.

#### Scenario: Each prompt mentions MINIFAC_STATUS

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** each of the four node prompts (`propose`, `apply`,
  `verify`, `archive`) contains the literal substring
  `MINIFAC_STATUS`

#### Scenario: Verify failure prompt documents the REASON line

- **WHEN** a reader inspects the `verify` node's prompt
- **THEN** the prompt instructs the model to emit
  `MINIFAC_STATUS: failed` followed by a `REASON:` line naming the
  failing verify command, so the next `apply` iteration receives a
  diagnosable failure description in `ctx.history`
