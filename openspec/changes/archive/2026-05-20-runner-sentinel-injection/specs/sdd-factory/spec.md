## MODIFIED Requirements

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
