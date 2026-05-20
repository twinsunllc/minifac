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
