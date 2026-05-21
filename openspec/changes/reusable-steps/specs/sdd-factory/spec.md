## MODIFIED Requirements

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

Every node in the shipped `examples/sdd.yaml` SHALL declare its `cwd` as the literal template string `"{{ run.cwd }}"`. The `cwd` field is a node-level field (per the `factory-schema` capability's "Node `uses:` field" requirement) that stays on the node regardless of whether the node uses inline `executor:` + `with:` or `uses:` + `inputs:`. No node SHALL declare a hand-edited absolute path as its `cwd`. The substitution semantics defined in the `graph-runner` capability's "Brief token substitution" and "Run-level cwd resolution" requirements bind: at runtime each node's `cwd` resolves to the worktree path the CLI created (or to `process.cwd()` under `--in-place` mode).

No shipped SDD prompt (in the factory or in any of its referenced steps) SHALL contain the literal placeholder `/path/to/target/repo`. The pre-this-change "edit each node's `cwd` per change" step is replaced by run-time substitution.

#### Scenario: Every node declares `cwd: "{{ run.cwd }}"`

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** for each of `propose`, `apply`, `verify`, and `archive`, the resolved `factory.nodes.<node>.cwd === "{{ run.cwd }}"`

#### Scenario: Factory file declares `cwd` on the node, not on the step

- **WHEN** the shipped `examples/sdd.yaml` is inspected on disk (pre-load)
- **THEN** each of the four node entries declares `cwd: "{{ run.cwd }}"` directly on the node alongside its `uses:` reference; no `cwd` field is declared inside any step file under `examples/steps/openspec-*.yaml`

#### Scenario: No node carries the old cwd placeholder

- **WHEN** the shipped `examples/sdd.yaml` is loaded
- **THEN** no resolved node's `cwd` contains the substring `/path/to/target/repo`

### Requirement: SDD factory nodes opt into claude executor authority controls

Every node in the shipped SDD factory SHALL declare `permission_mode: "bypass_permissions"`. Because the shipped factory references its node bodies via `uses:` step references (per the `factory-schema` capability and the `step-schema` capability), the `permission_mode` declaration SHALL live inside each step file's `with:` block (under `examples/steps/openspec-<phase>.yaml`), where it is inlined into the resolved factory node's `with:` at load time. The factory grants each spawned `claude` session full authority inside its resolved `cwd`.

The security posture SHALL be documented as user-trust-cwd: the user who invokes `minifac run` on this factory has explicitly chosen the target `cwd` and accepts that the spawned sessions may write, edit, and run side-effecting Bash inside it. The shipped prompts ship in this repository (in `examples/steps/`) and are readable before invocation; there is no remote prompt-injection vector.

The factory SHALL NOT declare `allowed_tools` or `add_dirs` on any resolved node. Under `bypass_permissions`, `allowed_tools` is redundant (every tool is granted) and `add_dirs` is unnecessary (nodes operate in `cwd`).

A future relaxation to `accept_edits` or stricter modes is permitted on user-copied factories or user-authored steps but is out of scope for the shipped templates; lowering the posture requires the copier to also supply an `allowed_tools` allowlist appropriate to their target repo.

#### Scenario: Each resolved node sets permission_mode

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** every resolved node in `factory.nodes` has `with.permission_mode === "bypass_permissions"`

#### Scenario: Each step file declares permission_mode

- **WHEN** the four shipped step files under `examples/steps/openspec-*.yaml` are loaded individually via the step loader
- **THEN** each loaded step's `with.permission_mode === "bypass_permissions"`

#### Scenario: No resolved node sets allowed_tools or add_dirs

- **WHEN** the shipped `examples/sdd.yaml` is loaded (with step references resolved and inlined)
- **THEN** no resolved node in `factory.nodes` declares `allowed_tools` or `add_dirs` in its `with:` block

#### Scenario: Shipping the factory without the authority field violates the spec

- **WHEN** a contributor edits any of the four shipped step files (`examples/steps/openspec-<phase>.yaml`) and removes `permission_mode` from its `with:` block
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
