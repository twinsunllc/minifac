# sdd-factory Specification

## Purpose
TBD - created by archiving change sdd-factory. Update Purpose after archive.
## Requirements
### Requirement: SDD example factory ships in the repo

The repository SHALL ship a canonical SDD example factory at
`examples/sdd.yaml` that loads, validates, and is runnable end-to-end
against an OpenSpec-equipped target repo using only the executors and
features documented in the canonical `factory-schema`,
`graph-runner`, `node-executor`, `check-merge-step`, and `run-cli`
capabilities. The factory SHALL use the `claude` executor for its
four model-driven phases and the `check-merge` executor for its
terminal mergeability probe. No further executors, no new schema
fields, and no new runner features are required for the factory to
load and run.

#### Scenario: Factory loads via the existing loader

- **WHEN** `loadFactory("examples/sdd.yaml")` is invoked
- **THEN** the loader returns a typed factory object without error

#### Scenario: Factory uses claude and check-merge executors

- **WHEN** the factory is loaded (with step references resolved and inlined)
- **THEN** the four model-driven nodes (`propose`, `apply`, `verify`, `archive`) have `executor === "claude"`, and the terminal `check-merge` node has `executor === "check-merge"`; no other executor types appear

### Requirement: SDD factory topology

The factory SHALL contain exactly five nodes named `propose`,
`apply`, `verify`, `archive`, and `check-merge`. The edges SHALL be
exactly:

- `propose → apply` (default `on_success`)
- `apply → verify` (default `on_success`)
- `verify → archive` (default `on_success`)
- `verify → apply` with `when: "on_failure"`
- `archive → check-merge` (default `on_success`)

The `check-merge` node SHALL be the sole node with `terminal: true`.
`archive` SHALL NOT be terminal. No `on_failure` edge SHALL exit
the `check-merge` node in v0 — a conflict ends the run as `failed`
and the brief stays at `inputs/<change>.md` for operator
intervention; the cycle-on-conflict edge story is filed under
`docs/Open-Questions.md` and is out of scope for this requirement.

#### Scenario: Nodes match the documented set

- **WHEN** the factory is loaded
- **THEN** the node ids are exactly
  `{propose, apply, verify, archive, check-merge}`

#### Scenario: Edges match the documented set

- **WHEN** the factory is loaded
- **THEN** the edges are exactly:
  - `propose → apply` (`on_success` default)
  - `apply → verify` (`on_success` default)
  - `verify → archive` (`on_success` default)
  - `verify → apply` with `when: "on_failure"`
  - `archive → check-merge` (`on_success` default)

#### Scenario: Check-merge is the only terminal node

- **WHEN** the factory is loaded
- **THEN** `check-merge.terminal === true` and no other node has
  `terminal: true`; in particular, `archive.terminal` is either
  unset or `false`

#### Scenario: Check-merge has no on_failure edge

- **WHEN** the factory is loaded
- **THEN** no edge exits the `check-merge` node (no `on_success`
  outgoing edge — it is terminal — and no `on_failure` outgoing
  edge in v0)

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
binds the responsibility, the underlying executor and command(s)
the node drives, and the status signal.

The four claude-executor nodes (`propose`, `apply`, `verify`,
`archive`) SHALL signal status via the `MINIFAC_STATUS` sentinel
parsed by the `claude` executor (see `node-executor` spec, "Status
signaling via sentinel marker"). Each such node's prompt SHALL
instruct the model to end its final assistant text with one of:

- `MINIFAC_STATUS: succeeded` — when the per-node contract is
  satisfied, or
- `MINIFAC_STATUS: failed` followed on the next line by
  `REASON: <single-line description>` — when the contract cannot be
  satisfied.

Exit codes are not part of these four nodes' contract. The
executor's exit-code fallback (per `node-executor`) remains the
safety net for sessions that crash before emitting a final
assistant message, but the factory does not rely on it.

The `check-merge` node SHALL NOT carry a prompt and SHALL NOT
use the sentinel mechanism. Its status is the standard `status`
event yielded by the `check-merge` executor per the
`check-merge-step` capability: `succeeded` when the merge would be
clean under the configured `mode`, `failed` otherwise.

The change name and per-change intent are NOT baked into the
prompts; they are supplied by the brief at runtime via
`{{ brief.change }}` and `{{ brief.body }}` substitution (see this
capability's "SDD factory prompts substitute brief fields via
template tokens" requirement and the `graph-runner` capability's
substitution rules).

- `propose` SHALL produce a complete OpenSpec change proposal under
  `openspec/changes/{{ brief.change }}/` (proposal, design, spec
  deltas, tasks) and SHALL drive
  `openspec validate {{ brief.change }}` to a clean exit before
  emitting `MINIFAC_STATUS: succeeded`. The propose prompt SHALL
  include a slot for `{{ brief.body }}` so the brief's body is
  available to the model as the per-change intent.
- `apply` SHALL implement the unchecked tasks in
  `openspec/changes/{{ brief.change }}/tasks.md`, marking each as
  done, and SHALL emit `MINIFAC_STATUS: succeeded` only when every
  checkbox is `- [x]`.
- `verify` SHALL run the target repo's verify commands (e.g. tests,
  build, lint) in the resolved `cwd`. `verify` SHALL emit
  `MINIFAC_STATUS: succeeded` only when every verify command exits
  zero, and `MINIFAC_STATUS: failed` (with a `REASON:` naming the
  failing command) otherwise.
- `archive` SHALL drive `openspec archive {{ brief.change }}`. On a
  clean exit from `openspec archive`, `archive` SHALL stage and commit
  the resulting file moves and spec folds in the resolved `cwd` with
  a subject line of the form `Archive: {{ brief.change }}` before
  emitting `MINIFAC_STATUS: succeeded`. If `openspec archive` exits
  non-zero, `archive` SHALL NOT attempt the commit and SHALL emit
  `MINIFAC_STATUS: failed`. If the commit itself fails (for example,
  a pre-commit hook in the target repo rejects it), `archive` SHALL
  emit `MINIFAC_STATUS: failed` with a `REASON:` line naming the
  commit failure. `archive` is no longer terminal — on success the
  factory routes to `check-merge`.
- `check-merge` SHALL invoke the `check-merge` executor (per the
  `check-merge-step` capability) against the configured base branch
  of the run's worktree (`{{ run.base_branch }}` resolved at
  dispatch time, by default). The node is terminal: success ends
  the run as `succeeded` (the change is mergeable); failure ends
  the run as `failed` (the change cannot merge as-is, and the
  brief stays at `inputs/<change>.md`).

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

#### Scenario: Archive success routes to check-merge

- **WHEN** `archive` emits `MINIFAC_STATUS: succeeded`
- **THEN** the runner schedules `check-merge` next via the
  `archive → check-merge` `on_success` edge; the run does not end
  at `archive`

#### Scenario: Check-merge success terminates the run as succeeded

- **WHEN** `check-merge` yields a final `status: "succeeded"` event
- **THEN** the run ends with status `succeeded`; the brief is
  eligible to move to `inputs/done/` (per `run-cli` / autorun
  semantics)

#### Scenario: Check-merge failure terminates the run as failed

- **WHEN** `check-merge` yields a final `status: "failed"` event
  (conflict, missing base, or fast-forward requirement violation)
- **THEN** the run ends with status `failed`; the brief stays at
  `inputs/<change>.md`; no further nodes are scheduled

#### Scenario: Sentinel-succeeded overrides a non-zero CLI exit

- **WHEN** any claude-executor SDD node's spawned `claude` CLI exits
  non-zero but its final assistant text ends with
  `MINIFAC_STATUS: succeeded`
- **THEN** the runner records the node as `succeeded` (per the
  `node-executor` sentinel precedence) and edge routing proceeds
  along `on_success`

#### Scenario: Sentinel-failed overrides a zero CLI exit

- **WHEN** any claude-executor SDD node's spawned `claude` CLI exits
  0 but its final assistant text ends with
  `MINIFAC_STATUS: failed\nREASON: ...`
- **THEN** the runner records the node as `failed` and edge routing
  proceeds along `on_failure` (for `verify`) or ends the run as
  `failed` (for `propose`, `apply`, `archive`, which have no
  `on_failure` edge)

#### Scenario: Archive commits after openspec archive succeeds

- **WHEN** the `archive` node runs `openspec archive {{ brief.change }}`
  and the command exits 0, leaving the resulting moves and spec folds
  staged-but-uncommitted in `cwd`
- **THEN** the node SHALL run `git add` and `git commit` (with a
  subject line of the form `Archive: {{ brief.change }}`) before
  emitting `MINIFAC_STATUS: succeeded`, and the working tree in `cwd`
  SHALL be clean of the archive-produced diff after the node returns

#### Scenario: Archive commit failure surfaces as a node failure

- **WHEN** the `archive` node runs `openspec archive {{ brief.change }}`
  cleanly but the subsequent `git commit` exits non-zero (for
  example, a pre-commit hook in `cwd` rejects the commit)
- **THEN** the node SHALL emit `MINIFAC_STATUS: failed` followed by
  a `REASON:` line that names the commit failure, and SHALL NOT
  emit `MINIFAC_STATUS: succeeded`

### Requirement: SDD factory ships per-node documentation

The repository SHALL ship `examples/sdd.md` alongside `examples/sdd.yaml`
documenting each node's contract in human-readable form, the
brief-driven invocation workflow, and the on-disk location convention
for briefs (`inputs/<change>.md`). The doc SHALL explain that the
shipped factory is invoked by name (`minifac run <change-name>`
resolving to `inputs/<change-name>.md`) rather than by editing the
YAML per change; it SHALL reference `examples/sample-brief.md` as the
shape to author against.

#### Scenario: Per-node documentation exists

- **WHEN** the repository is inspected
- **THEN** `examples/sdd.md` exists and documents the contract for
  each of `propose`, `apply`, `verify`, and `archive`

#### Scenario: Documentation references the brief workflow

- **WHEN** a reader inspects `examples/sdd.md`
- **THEN** the doc names the `inputs/<change>.md` location convention,
  references `examples/sample-brief.md` as the brief template, and
  describes invoking the factory by change name through the verb
  `minifac run <change>`

### Requirement: SDD factory is the documented template, not a runnable singleton

The shipped `examples/sdd.yaml` SHALL NOT be a hand-edited template.
Users SHALL invoke the SDD factory by:

1. authoring a brief at `inputs/<change-name>.md` (per the
   `brief-schema` capability) whose `factory:` field resolves to the
   shipped `examples/sdd.yaml`;
2. invoking `minifac run <change-name>` (per the `run-cli`
   capability's lookup precedence).

The documentation SHALL state explicitly that the prior "copy
`examples/sdd.yaml` to `sdd-<change>.yaml` and find-and-replace
`<CHANGE_NAME>`" workflow is removed. The two pre-this-change required
edits (change name embedded in prompts; per-node `cwd`) are now
expressed: change name as `{{ brief.change }}` resolved at runtime
from the brief; per-node `cwd` as `{{ run.cwd }}` resolved at
runtime from the worktree the CLI creates (per the
`worktree-management` capability). The shipped factory SHALL run
end-to-end via `minifac run <change>` against any OpenSpec-equipped
target repo without any hand edit to the shipped YAML.

#### Scenario: README and sdd.md point users to the brief workflow

- **WHEN** a user reads `README.md`'s "Run the example" section or
  `examples/sdd.md`
- **THEN** the section instructs the user to author a brief at
  `inputs/<change>.md` and invoke `minifac run <change>`, and does
  not instruct the user to copy or edit `examples/sdd.yaml`

#### Scenario: Shipped `examples/sdd.yaml` is runnable as authored

- **WHEN** a user authors a valid brief at `inputs/<change>.md` whose
  `factory:` field resolves to the shipped `examples/sdd.yaml`, and
  invokes `minifac run <change>`
- **THEN** the CLI creates a worktree, loads the brief and the
  unchanged shipped `examples/sdd.yaml`, and runs the factory
  end-to-end inside the worktree without any hand edit to the
  shipped YAML

### Requirement: SDD factory nodes opt into claude executor authority controls

Every claude-executor node in the shipped SDD factory SHALL declare
`permission_mode: "bypass_permissions"`. Because the shipped
factory references its claude-executor node bodies via `uses:` step
references (per the `factory-schema` capability and the
`step-schema` capability), the `permission_mode` declaration SHALL
live inside each step file's `with:` block (under
`examples/steps/openspec-<phase>.yaml`), where it is inlined into
the resolved factory node's `with:` at load time. The factory
grants each spawned `claude` session full authority inside its
resolved `cwd`.

The `check-merge` node SHALL NOT declare `permission_mode` —
`permission_mode` is a `claude`-executor `with:` field with no
meaning for the `check-merge` executor, and the `check-merge`
executor's `with:` schema (per the `check-merge-step` capability)
rejects unknown keys.

The security posture SHALL be documented as user-trust-cwd: the
user who invokes `minifac run` on this factory has explicitly
chosen the target `cwd` and accepts that the spawned sessions may
write, edit, and run side-effecting Bash inside it. The shipped
prompts ship in this repository (in `examples/steps/`) and are
readable before invocation; there is no remote prompt-injection
vector.

The factory SHALL NOT declare `allowed_tools` or `add_dirs` on any
claude-executor resolved node. Under `bypass_permissions`,
`allowed_tools` is redundant (every tool is granted) and `add_dirs`
is unnecessary (nodes operate in `cwd`).

A future relaxation to `accept_edits` or stricter modes is
permitted on user-copied factories or user-authored steps but is
out of scope for the shipped templates; lowering the posture
requires the copier to also supply an `allowed_tools` allowlist
appropriate to their target repo.

#### Scenario: Each claude-executor node sets permission_mode

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** for each of `propose`, `apply`, `verify`, and `archive`, the resolved `factory.nodes.<node>.with.permission_mode === "bypass_permissions"`

#### Scenario: Each claude-executor step file declares permission_mode

- **WHEN** the four shipped step files under `examples/steps/openspec-*.yaml` are loaded individually via the step loader
- **THEN** each loaded step's `with.permission_mode === "bypass_permissions"`

#### Scenario: Check-merge node does not declare permission_mode

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** the resolved `check-merge` node's `with` declares no `permission_mode` key (and no `allowed_tools` or `add_dirs` either; the `check-merge` executor's `with:` schema accepts only `base` and `mode`)

#### Scenario: No claude-executor resolved node sets allowed_tools or add_dirs

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** for each of `propose`, `apply`, `verify`, and `archive`, the resolved node's `with` declares neither `allowed_tools` nor `add_dirs`

#### Scenario: Shipping the factory without the authority field violates the spec

- **WHEN** a contributor edits any of the four shipped claude-executor step files (`examples/steps/openspec-<phase>.yaml`) and removes `permission_mode` from its `with:` block
- **THEN** the spec is violated and the structural test in `src/factory/sdd-example.test.ts` fails

### Requirement: SDD factory prompts instruct the model to emit MINIFAC_STATUS

Each of the four shipped SDD node prompts SHALL declare, in prose, what success and failure mean for that node — the per-node *criteria*. Because the shipped factory references its node bodies via `uses:` step references, the prose lives in the referenced step files under `examples/steps/openspec-<phase>.yaml`, where it is inlined into the resolved factory node's `with.prompt` at load time. The mechanics of how the model communicates that outcome (the `MINIFAC_STATUS:` sentinel format, where it must appear, and that it must be the last thing in the message) SHALL NOT be re-stated in either the YAML factory or the step prompts; per the `node-executor` capability the `claude` executor auto-injects those mechanics into every prompt it sends.

Concretely, each shipped step prompt SHALL describe its own success and failure semantics so the model knows what to report:

- `openspec-propose` step (used by the `propose` node): success means `openspec validate <change>` exits 0 and the required artifacts (proposal, design, spec deltas, tasks) are on disk; failure means validate stays dirty or a required artifact cannot be written.
- `openspec-apply` step (used by the `apply` node): success means every task in `openspec/changes/<change>/tasks.md` is checked `- [x]`; failure means a task is structurally blocked.
- `openspec-verify` step (used by the `verify` node): success means every verify command exits 0; failure means any verify command exits non-zero. The prompt SHALL further instruct that on failure, the `REASON:` line accompanying the sentinel must name the failing command and the diagnosable output, because that text is what the next `apply` iteration reads from `ctx.history`.
- `openspec-archive` step (used by the `archive` node): success means `openspec archive <change>` exits 0 AND the subsequent `git commit` exits 0; failure means either step exits non-zero.

The shipped step prompts SHALL NOT instruct the model to influence the CLI exit code as the primary status signal. Exit-code influence is the executor's fallback (per `node-executor`) and is not part of the factory's contract.

The exact wording of the criteria is implementation. The binding contract is: each step's prompt makes its per-node success and failure semantics legible, in prose, to the model.

#### Scenario: Each resolved prompt names its success criterion

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** each of the four resolved node prompts (`propose`, `apply`, `verify`, `archive`) contains prose describing the node's success criterion using domain language specific to that node (for example: `openspec validate` for `propose`; `tasks.md` checkboxes for `apply`; "verify command" or `npm test` for `verify`; `openspec archive` and `git commit` for `archive`)

#### Scenario: Verify-step prompt documents the REASON content

- **WHEN** the shipped `examples/steps/openspec-verify.yaml` is inspected (or the resolved `verify` node's prompt is inspected post-load)
- **THEN** the prompt instructs the model that on failure the failure description must name the failing verify command and its relevant output, so the next `apply` iteration receives a diagnosable failure description in `ctx.history`

#### Scenario: Prompts no longer carry the sentinel mechanics boilerplate

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** no resolved node's prompt contains a `## Status signaling` section, no resolved node's prompt re-states the canonical sentinel regex, and the literal substring `MINIFAC_STATUS` does not appear in any resolved node's prompt; those instructions are the runner's responsibility per `node-executor`

### Requirement: SDD factory declares `brief: required`

The shipped `examples/sdd.yaml` SHALL declare a top-level
`brief: required` field. This binds the SDD factory to the
brief-driven workflow: invocation without a brief SHALL be rejected by
the CLI (per the `run-cli` capability's brief-mode enforcement) before
any node executes.

#### Scenario: Loaded factory exposes brief mode

- **WHEN** `loadFactory("examples/sdd.yaml")` is invoked
- **THEN** the returned factory object has `brief === "required"`

### Requirement: SDD factory prompts substitute brief fields via template tokens

Every shipped SDD node prompt SHALL express change-specific values as `{{ brief.<field> }}` template tokens rather than hand-edited placeholders. The shipped factory references its node bodies via `uses:` step references (per the `factory-schema` capability's "Node `uses:` field" requirement and the `step-schema` capability), so the literal `{{ brief.* }}` and `{{ inputs.* }}` tokens live in the referenced step files under `examples/steps/`, not in the factory file itself. The resolved factory (post step inlining) SHALL carry these tokens in each node's `with.prompt`. Concretely:

- The resolved `propose` node's `with.prompt` SHALL contain the literal token `{{ brief.change }}` (referencing the change name) and the literal token `{{ brief.body }}` (the slot into which the brief's body is substituted at runtime), via the `openspec-propose` step's body and the factory's `inputs: { change: "{{ brief.change }}", brief_body: "{{ brief.body }}" }` mapping (which threads brief tokens through `{{ inputs.change }}` and `{{ inputs.brief_body }}` in the step body).
- The resolved `apply`, `verify`, and `archive` nodes' `with.prompt` SHALL each contain the literal token `{{ brief.change }}` wherever they refer to the change name, threaded via the same `inputs:` → `{{ inputs.change }}` indirection.
- No shipped SDD prompt (in the factory or in any of its referenced steps) SHALL contain the literal placeholder `<CHANGE_NAME>`. The pre-this-change "copy-and-edit per change" workflow is replaced by brief-driven runtime substitution flowing through step inputs.

The token grammar and substitution semantics are defined by the `graph-runner` capability's "Brief token substitution" requirement; this requirement binds the resolved factory's surface (post step inlining) to using them.

#### Scenario: Propose resolved node carries change and body tokens

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined per the `factory-schema` capability)
- **THEN** the resolved `factory.nodes.propose.with.prompt` contains the substrings `{{ brief.change }}` and `{{ brief.body }}`

#### Scenario: Non-propose resolved nodes carry the change token

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** for each of `apply`, `verify`, and `archive`, the resolved `factory.nodes.<node>.with.prompt` contains the substring `{{ brief.change }}`

#### Scenario: No resolved prompt carries the old placeholder

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** no resolved node's `with.prompt` contains the substring `<CHANGE_NAME>`

#### Scenario: Step files exist for each SDD phase

- **WHEN** the repository is inspected
- **THEN** `examples/steps/openspec-propose.yaml`, `examples/steps/openspec-apply.yaml`, `examples/steps/openspec-verify.yaml`, and `examples/steps/openspec-archive.yaml` all exist, each parseable as a step per the `step-schema` capability

#### Scenario: Factory references steps via `uses:`

- **WHEN** the shipped `examples/sdd.yaml` is inspected on disk (pre-load)
- **THEN** each of the four nodes declares a `uses:` field referencing the corresponding `examples/steps/openspec-<phase>.yaml` step; no node declares inline `executor:` + `with:`

### Requirement: SDD factory nodes use `{{ run.cwd }}` as their cwd

Every node in the shipped `examples/sdd.yaml` SHALL declare its `cwd` as the literal template string `"{{ run.cwd }}"`, and the new `check-merge` node SHALL be no exception. The `cwd` field is a node-level
field (per the `factory-schema` capability's "Node `uses:` field"
requirement) that stays on the node regardless of whether the node
uses inline `executor:` + `with:` or `uses:` + `inputs:`. No node
SHALL declare a hand-edited absolute path as its `cwd`. The
substitution semantics defined in the `graph-runner` capability's
"Brief token substitution" and "Run-level cwd resolution"
requirements bind: at runtime each node's `cwd` resolves to the
worktree path the CLI created (or to `process.cwd()` under
`--in-place` mode).

No shipped SDD prompt (in the factory or in any of its referenced
steps) SHALL contain the literal placeholder `/path/to/target/repo`.

#### Scenario: Every node declares `cwd: "{{ run.cwd }}"`

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** for each of `propose`, `apply`, `verify`, `archive`, and `check-merge`, the resolved `factory.nodes.<node>.cwd === "{{ run.cwd }}"`

#### Scenario: Factory file declares `cwd` on the node, not on the step

- **WHEN** the shipped `examples/sdd.yaml` is inspected on disk (pre-load)
- **THEN** each of the five node entries declares `cwd: "{{ run.cwd }}"` directly on the node alongside its `uses:` reference; no `cwd` field is declared inside any step file under `examples/steps/`

#### Scenario: No node carries the old cwd placeholder

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** no resolved node's `cwd` contains the substring `/path/to/target/repo`

### Requirement: SDD factory adopts the check-merge step after archive

The shipped `examples/sdd.yaml` SHALL declare a fifth node named
`check-merge` that references the bundled built-in step via
`uses: minifac:check-merge`. The node SHALL be `terminal: true`
and SHALL be reached only by the `on_success` edge from `archive`.
The node MAY declare an `inputs:` block to override the step's
defaults, but the shipped factory SHALL NOT override either input
— the step's defaults (`base: "{{ run.base_branch }}"`,
`mode: "any-merge"`) are the correct shape for the SDD loop and
shipping overrides would obscure that.

#### Scenario: Factory file declares the check-merge node

- **WHEN** the shipped `examples/sdd.yaml` is inspected on disk (pre-load)
- **THEN** the file declares a node named `check-merge` with
  `uses: minifac:check-merge`, `terminal: true`, and `cwd: "{{ run.cwd }}"`,
  and either omits the `inputs:` block entirely or supplies it as an empty mapping

#### Scenario: Resolved check-merge node carries default with values

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** the resolved `check-merge` node's `with.base` is the literal token string `"{{ run.base_branch }}"` (to be resolved by the runner at dispatch time) and its `with.mode === "any-merge"`

#### Scenario: Archive routes to check-merge on success

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** the edge set contains `archive → check-merge` with no
  explicit `when` clause (or with `when: "on_success"`), and no
  other outgoing edge exists from `archive`

