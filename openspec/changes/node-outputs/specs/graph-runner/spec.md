## ADDED Requirements

### Requirement: Per-node-per-iteration outputs directory

The runner SHALL compute a per-dispatch outputs directory for
every scheduled node iteration. The path SHALL be:

```
${MINIFAC_HOME}/outputs/<run-id>/<node-id>/<iteration>/
```

where `MINIFAC_HOME` is the existing root (env override →
`~/.minifac`), `<run-id>` is the run id minted at run start (per
the "Optional `RunStore` persistence" requirement; when no store
is in scope, the runner SHALL still mint a run id local to the
invocation for outputs-directory naming purposes), `<node-id>` is
the factory node id, and `<iteration>` is the 1-based iteration
counter for that node within the current run.

The runner SHALL create the directory (recursive mkdirp,
permissions `0o755`) immediately before dispatching the node to
its executor. Creation SHALL be unconditional: every dispatched
node iteration receives its outputs directory, including nodes
that declare no `outputs:` block (the directory then remains
empty unless the executor writes ad-hoc files to it).

The resolved outputs-directory path SHALL be passed to the
executor through the run context as `ctx.outputsDir` (string),
and SHALL be exposed to substitution as the
`{{ run.outputs_dir }}` token (per the modified "Brief token
substitution" requirement below).

When the runner is invoked without a store (e.g. unit tests
invoking `runFactory` directly), the run id minted for outputs
directory naming SHALL be a fresh UUID-shaped value distinct from
any other concurrent run's id. The directory layout SHALL be
identical to store-backed runs so test fixtures can assert paths
without branching on store presence.

#### Scenario: Outputs directory exists before dispatch

- **WHEN** the runner is about to dispatch node `propose`
  iteration 1 of run id `abcd1234...` and the node declares
  `outputs: { findings: { type: "value" } }`
- **THEN** the path `~/.minifac/outputs/abcd1234.../propose/1/`
  exists as a directory before the executor is invoked

#### Scenario: Outputs directory exists for nodes without declared outputs

- **WHEN** the runner dispatches a node that declares no
  `outputs:` block
- **THEN** the per-node-per-iteration outputs directory is still
  created (so `{{ run.outputs_dir }}` resolves to a usable path
  if the prompt happens to reference it)

#### Scenario: Outputs directory uses run id local to invocation

- **WHEN** the runner is invoked without a `store` argument
- **THEN** the run id used in the outputs directory path is a
  freshly minted UUID-shaped value unique to that invocation;
  the directory exists under that id

#### Scenario: Each iteration of a node gets a fresh directory

- **WHEN** node `verify` runs twice in a cycle (iteration 1, then
  iteration 2 after a failure-edge loop)
- **THEN** both
  `~/.minifac/outputs/<run-id>/verify/1/` and
  `~/.minifac/outputs/<run-id>/verify/2/` exist; the iteration-1
  directory is not overwritten or moved when iteration 2 starts

### Requirement: Post-execution outputs validation

The runner SHALL validate each node's declared outputs against the contents of its outputs directory after the executor terminates and the node's terminal status is resolved (per existing event-drain rules) and before recording the entry in `priorResults` / invoking the store's `recordNodeEnd`.

Validation SHALL run only when ALL of the following hold:

- The node declares an `outputs:` block (per the
  `factory-schema` capability's "Node `outputs:` block"
  requirement); AND
- The node's resolved terminal status is `succeeded` (sentinel
  succeeded; non-sentinel exit-zero terminations also count).

When the node's resolved terminal status is `failed` for any
reason (sentinel failure, non-zero exit, executor error), the
outputs validation pass SHALL be skipped entirely. The node's
existing failure reason is preserved; the `NodeResult.outputs`
field SHALL be `null` for a skipped-validation node.

For each declared output `(key, def)` in the node's `outputs:`
map, the validator SHALL:

- **`type: "value"`** — look for `<outputs_dir>/<key>.json`. If
  present, attempt to parse it as JSON. If the file is missing,
  treat as absent. If the file exists but JSON parse fails,
  treat as **present-but-invalid** (counts the same as missing
  for required-output purposes; the validator records the parse
  error in the failure reason text).
- **`type: "file"`** — when `def.filename` is set, look for
  `<outputs_dir>/<def.filename>`. When `def.filename` is absent,
  glob `<outputs_dir>/<key>.*` (one or more characters after the
  dot). Zero matches → absent. Exactly one match → present, path
  is the match. Multiple matches → **present-but-ambiguous**
  (counts the same as missing; the validator records "ambiguous
  file output matched N files: <list>" in the failure reason).
- **`type: "directory"`** — look for `<outputs_dir>/<key>/` as a
  directory. Missing or not-a-directory → absent. Empty directory
  → **present-but-empty** (counts the same as missing). Directory
  with one or more files (at any depth) → present.

For each present output, the validator SHALL stat the file (or
the directory) and record `{ type, path, size, mtime }` in the
`NodeOutputIndex` for that node iteration:

- `path` is the absolute filesystem path.
- `size` is the file size in bytes for `value` and `file`
  outputs; for `directory` outputs, the total recursive byte
  count of contained files.
- `mtime` is the file's `mtime` in epoch ms for `value` and
  `file` outputs; for `directory` outputs, the latest `mtime`
  of any contained file.

After scanning all declared outputs, the validator SHALL collect
the keys whose `required: true` declaration is unsatisfied
(absent, present-but-invalid, present-but-ambiguous, or
present-but-empty). If that set is non-empty, the validator SHALL
override the node's terminal status:

- New status: `failed`
- New `reason`: the string `missing_required_output`
- The `NodeResult.meta` (or equivalent runner-internal failure
  metadata) SHALL carry `missing_outputs: string[]` listing the
  offending keys, and a `missing_outputs_detail` string naming
  each key's specific failure mode (absent / parse error /
  ambiguous / empty).

The `NodeOutputIndex` (for the keys that *were* present) SHALL
still be populated and persisted even when the override fires;
operators inspecting the failed node can still see what the model
did write.

When all required outputs are satisfied (or none are required),
the node's existing terminal status is preserved unchanged and
the `NodeOutputIndex` is populated for every present output
(required and optional).

#### Scenario: Required value output present and parseable passes

- **WHEN** node `propose` declares `outputs: { findings:
  { type: "value", required: true } }`, terminates `succeeded`,
  and `<outputs_dir>/findings.json` exists with valid JSON
- **THEN** the node's terminal status remains `succeeded`; the
  `NodeOutputIndex` carries `findings: { type: "value", path,
  size, mtime }`

#### Scenario: Required value output absent fails the node

- **WHEN** node `propose` declares `outputs: { findings:
  { type: "value", required: true } }`, terminates `succeeded`,
  and `<outputs_dir>/findings.json` does not exist
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["findings"]`

#### Scenario: Required value output present but unparseable fails the node

- **WHEN** node `propose` declares `outputs: { findings:
  { type: "value", required: true } }`, terminates `succeeded`,
  and `<outputs_dir>/findings.json` exists but is not valid
  JSON (e.g. truncated mid-object)
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["findings"]` and a detail string
  naming the JSON parse error

#### Scenario: Required file output absent fails the node

- **WHEN** node `apply` declares `outputs: { patch:
  { type: "file", filename: "patch.diff", required: true } }`,
  terminates `succeeded`, and `<outputs_dir>/patch.diff` does
  not exist
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["patch"]`

#### Scenario: Required file output without filename uses glob discovery

- **WHEN** node `apply` declares `outputs: { patch:
  { type: "file", required: true } }` (no `filename`),
  terminates `succeeded`, and `<outputs_dir>/patch.diff` is the
  only file matching `patch.*`
- **THEN** the node succeeds; the `NodeOutputIndex` carries
  `patch: { type: "file", path: "<outputs_dir>/patch.diff", ... }`

#### Scenario: Required file output with ambiguous glob fails the node

- **WHEN** node `apply` declares `outputs: { patch:
  { type: "file", required: true } }` and `<outputs_dir>`
  contains both `patch.diff` and `patch.txt`
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["patch"]` and a detail string
  listing the matched files

#### Scenario: Required directory output present and non-empty passes

- **WHEN** node `verify` declares `outputs: { logs:
  { type: "directory", required: true } }`, terminates
  `succeeded`, and `<outputs_dir>/logs/` contains at least one
  file
- **THEN** the node succeeds; the `NodeOutputIndex` carries
  `logs: { type: "directory", path, size (sum of contained
  files), mtime (latest contained mtime) }`

#### Scenario: Required directory output empty fails the node

- **WHEN** node `verify` declares `outputs: { logs:
  { type: "directory", required: true } }`, terminates
  `succeeded`, and `<outputs_dir>/logs/` exists but contains
  no files
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output`; the failure metadata
  carries `missing_outputs: ["logs"]`

#### Scenario: Optional output missing does not fail the node

- **WHEN** node `propose` declares `outputs: { notes:
  { type: "value", required: false } }` (or required omitted,
  defaulting to false), terminates `succeeded`, and
  `<outputs_dir>/notes.json` does not exist
- **THEN** the node succeeds; the `NodeOutputIndex` carries no
  entry for `notes`; downstream `{{ priorResults.propose.outputs.notes }}`
  resolves to the empty string

#### Scenario: Optional output present is indexed

- **WHEN** node `propose` declares `outputs: { notes:
  { type: "value", required: false } }`, terminates `succeeded`,
  and `<outputs_dir>/notes.json` exists with valid JSON
- **THEN** the node succeeds; the `NodeOutputIndex` carries
  `notes: { type: "value", path, size, mtime }`

#### Scenario: Failed-sentinel node skips outputs validation

- **WHEN** node `verify` declares `outputs: { results:
  { type: "value", required: true } }` and terminates `failed`
  with reason `"verify hit 3 test failures"` (sentinel failure)
- **THEN** the outputs validation pass is skipped; the node's
  terminal status remains `failed` with the sentinel reason
  preserved verbatim; `NodeResult.outputs` is `null`; the
  failure metadata does NOT carry `missing_outputs`

#### Scenario: Non-sentinel failure (non-zero exit) skips outputs validation

- **WHEN** a node declares `outputs:` with at least one required
  entry and the executor exits non-zero without emitting a
  sentinel
- **THEN** the outputs validation pass is skipped; the node's
  terminal status remains `failed`; `NodeResult.outputs` is `null`

#### Scenario: Node without `outputs:` declaration has null outputs index

- **WHEN** a node declares no `outputs:` block and terminates
  `succeeded`
- **THEN** the outputs validation pass is skipped (no work to
  do); `NodeResult.outputs` is `null`; ad-hoc files in
  `<outputs_dir>` are not scanned or indexed

#### Scenario: Override preserves the partial index

- **WHEN** node `propose` declares two outputs `findings:
  { type: "value", required: true }` and `notes:
  { type: "value", required: false }`, terminates `succeeded`,
  and only `notes.json` exists on disk
- **THEN** the node's terminal status is overridden to `failed`
  with reason `missing_required_output` and metadata
  `missing_outputs: ["findings"]`; the `NodeOutputIndex` still
  carries `notes: { type: "value", path, size, mtime }` (the
  partial index of present outputs)

### Requirement: `NodeResult.outputs` field on prior results

The runner SHALL extend the `NodeResult` shape (per the existing "Prior-results accumulate" requirement) with an `outputs` field whose value is one of:

- `NodeOutputIndex` — a `Record<string, NodeOutputEntry>` where
  each `NodeOutputEntry` has shape
  `{ type: "value" | "file" | "directory"; path: string;
  size: number; mtime: number }`. The map's keys are the
  declared output keys; entries are present only for outputs the
  validator determined were present-and-satisfied.
- `null` — when the node declared no `outputs:`, when the node
  terminated `failed` (validation was skipped), or when the
  validator found no present outputs (none declared as
  satisfied).

The field SHALL be added to the snapshot the runner passes
through the run context as `ctx.priorResults`. Downstream nodes
(in the same run) consume it via the `priorResults.<id>.outputs.<key>`
template token (per the modified "Brief token substitution"
requirement below).

#### Scenario: NodeResult carries outputs index on success

- **WHEN** node `propose` declares two satisfied value outputs
  and terminates `succeeded`
- **THEN** the `priorResults` entry for `propose` has `outputs`
  as a `NodeOutputIndex` containing both keys with `type`,
  `path`, `size`, `mtime` populated

#### Scenario: NodeResult.outputs is null on failure

- **WHEN** node `verify` declares outputs and terminates
  `failed` for any reason
- **THEN** the `priorResults` entry for `verify` has
  `outputs: null`

#### Scenario: NodeResult.outputs is null when no outputs declared

- **WHEN** a node declares no `outputs:` block and terminates
  `succeeded`
- **THEN** the `priorResults` entry for that node has
  `outputs: null`

## MODIFIED Requirements

### Requirement: Brief token substitution before node dispatch

The runner SHALL accept an optional `brief` argument identifying the
brief that initiated the run and an optional `runCwd` argument
carrying the run-level cwd (see the "Run-level cwd resolution"
requirement). Together with the per-node inputs map produced by step
inlining (see the `factory-schema` capability's "Step inlining order"
and "Step input validation" requirements), the per-node outputs
directory (per the "Per-node-per-iteration outputs directory"
requirement), and the run-wide `priorResults` snapshot (per the
"Prior-results accumulate" requirement), these form the
substitution namespaces the runner offers to each scheduled node.

For each scheduled node, immediately before dispatching to the
node's executor, the runner SHALL substitute template tokens in
both:

- the node's `with.prompt` field (if and only if it is a string), and
- the node's `cwd` field (if and only if it is a non-empty string)

The token grammar SHALL be the union of two forms:

1. **Simple namespace token:** literal `{{`, optional ASCII
   whitespace, a namespace identifier (`brief`, `run`, or
   `inputs`), literal `.`, a field identifier matching
   `[a-zA-Z_][a-zA-Z0-9_]*`, optional ASCII whitespace, literal
   `}}`.
2. **Prior-results output token:** literal `{{`, optional ASCII
   whitespace, the literal `priorResults`, literal `.`, a
   node-id identifier matching `[a-zA-Z_][a-zA-Z0-9_-]*` (node
   ids allow hyphens per existing factory schema), literal
   `.outputs.`, an output-key identifier matching
   `[a-zA-Z_][a-zA-Z0-9_]*`, an optional `:read` suffix
   (literal colon followed by the literal `read`), optional
   ASCII whitespace, literal `}}`.

The runner SHALL match these grammars globally across each
target string.

Field resolution rules per matched token:

- `brief.change`, `brief.body`, `brief.factory`: substitute the
  corresponding string value from the resolved brief. These fields
  are always present on a resolved brief.
- `brief.base_branch`, `brief.model`: substitute the string value if
  present on the brief; otherwise substitute the empty string.
- `run.cwd`: substitute the run's `runCwd` value (the worktree path
  or the in-place cwd, as supplied by the CLI) when `runCwd` is in
  scope; otherwise leave the token verbatim.
- `run.outputs_dir`: substitute the absolute path of the current
  node's per-iteration outputs directory (per the
  "Per-node-per-iteration outputs directory" requirement). This
  token is always in scope (the runner always creates the
  directory before dispatch, even in store-less invocations); it
  SHALL NOT pass through verbatim.
- `inputs.<field>`: substitute the corresponding value from the
  per-node inputs map produced by step inlining. When the value is
  a string, substitute it verbatim. When the value is a number,
  boolean, array, or object, substitute its `String(value)` form
  (numbers and booleans stringify to their natural string
  representations; arrays and objects stringify via
  `JSON.stringify` so the executor receives a deterministic
  textual form). When the node has no `inputs` map in scope (the
  node was not inlined from a step), `inputs.*` tokens SHALL be
  left verbatim. When the node has an inputs map but the named
  field is absent (optional input with no default and no node
  supply), the token SHALL substitute the empty string. When the
  node has an inputs map and the named field is present but its
  value is `null` or `undefined`, the token SHALL substitute the
  empty string.
- `priorResults.<node-id>.outputs.<key>` (no `:read`):
  substitute the absolute filesystem path of the latest-iteration
  produced output for `(node-id, key)`. The lookup SHALL consult
  a `Map<nodeId, NodeResult>` built at dispatch time from
  `priorResults`, with the latest entry per node id winning. If
  the named node has no prior result in this run, OR the named
  node's `outputs` is `null`, OR the named key is not present
  in the node's `NodeOutputIndex`, the token SHALL substitute
  the empty string (the same convention as missing-optional
  brief / inputs fields).
- `priorResults.<node-id>.outputs.<key>:read`: locate the
  produced output the same way as the no-suffix form. When
  found and the indexed `size` is ≤ 65536 (64 KB), read the
  file and substitute its contents verbatim (preserving line
  endings as on disk; no encoding conversion). When found and
  the size exceeds 64 KB, the substitution pass SHALL throw a
  template-substitution error naming the node id, the output
  key, the actual size in bytes, and the cap. When not found,
  the token SHALL substitute the empty string. The `:read`
  suffix is only meaningful for `value` and `file` outputs; for
  `directory` outputs the runner SHALL throw a
  template-substitution error naming the offending key and
  explaining that `:read` is not valid for directory outputs.
- For any other identifier under a known namespace (e.g.
  `brief.depends_on`, `run.id`): leave the token verbatim in the
  string (no error, no substitution).
- For any token whose namespace is not `brief`, `run`, `inputs`,
  or `priorResults`: leave the token verbatim in the string.

When the run has no brief, `brief.*` tokens SHALL be left verbatim.
When the run has no `runCwd` in scope (e.g. a unit-test invocation
of `runFactory` without the CLI sequencing wrapper), `run.cwd`
tokens SHALL be left verbatim. `run.outputs_dir` is always in
scope (see above). When the node has no inputs map (inline
node, not produced by step inlining), `inputs.*` tokens SHALL be
left verbatim. When the run has an empty `priorResults`
(the first scheduled node, before any other completes),
`priorResults.<id>.outputs.<key>` tokens SHALL substitute the
empty string per the "not found" rule above.

Substitution SHALL happen in the runner, not in the executor. The
executor sees the resolved strings with no tokens (when the relevant
namespace is in scope) or the verbatim string (when not). The
executor interface and its `with:` validation are unchanged by this
requirement.

#### Scenario: `{{ brief.change }}` substitutes the change name

- **WHEN** a node's `with.prompt` is
  `"Work on change {{ brief.change }}."` and the run's brief has
  `change: "foo"`
- **THEN** the executor receives `with.prompt` equal to
  `"Work on change foo."`

#### Scenario: `{{ brief.body }}` substitutes the brief body verbatim

- **WHEN** a node's `with.prompt` is
  `"## Intent\n\n{{ brief.body }}"` and the run's brief has body
  `"Make X happen.\nPlease."`
- **THEN** the executor receives `with.prompt` equal to
  `"## Intent\n\nMake X happen.\nPlease."`

#### Scenario: Missing optional field substitutes empty string

- **WHEN** a node's `with.prompt` is
  `"Base branch: {{ brief.base_branch }}."` and the run's brief omits
  `base_branch`
- **THEN** the executor receives `with.prompt` equal to
  `"Base branch: ."`

#### Scenario: Unknown identifier passes through verbatim

- **WHEN** a node's `with.prompt` is
  `"Future field: {{ brief.depends_on }}."` and the run has any brief
- **THEN** the executor receives `with.prompt` equal to
  `"Future field: {{ brief.depends_on }}."` (verbatim, no error)

#### Scenario: Tokenless prompt is unchanged

- **WHEN** a node's `with.prompt` is
  `"Say hello in one sentence."` and the run has a brief
- **THEN** the executor receives `with.prompt` equal to
  `"Say hello in one sentence."` (byte-identical)

#### Scenario: Brief-less run leaves brief tokens verbatim

- **WHEN** a node's `with.prompt` contains `{{ brief.change }}` and
  the run has no brief in scope (brief-less factory invocation)
- **THEN** the executor receives `with.prompt` with the token preserved
  verbatim; the executor's existing validation behavior applies to the
  unchanged string

#### Scenario: Non-string `with.prompt` is left alone

- **WHEN** a node's `with.prompt` is not a string (or the node has no
  `with.prompt` at all)
- **THEN** the runner performs no substitution on that node's
  `with.prompt`; the executor's existing `with:` validation applies
  as today

#### Scenario: `{{ run.cwd }}` substitutes in the cwd field

- **WHEN** a node's `cwd` is `"{{ run.cwd }}"` and the runner's
  `runCwd` is `/Users/x/.minifac/worktrees/abcd-foo`
- **THEN** the executor receives `cwd` equal to
  `"/Users/x/.minifac/worktrees/abcd-foo"`

#### Scenario: `{{ run.cwd }}` substitutes inside `with.prompt` too

- **WHEN** a node's `with.prompt` is
  `"Working directory: {{ run.cwd }}."` and the runner's `runCwd`
  is `/tmp/wt`
- **THEN** the executor receives `with.prompt` equal to
  `"Working directory: /tmp/wt."`

#### Scenario: `{{ run.cwd }}` with no runCwd in scope passes through

- **WHEN** a node's `cwd` is `"{{ run.cwd }}"` and the runner was
  invoked without a `runCwd` argument
- **THEN** the substitution pass leaves the field as
  `"{{ run.cwd }}"` and the default-cwd fallback (per the
  "Run-level cwd resolution" requirement) determines what the
  executor receives

#### Scenario: Unknown `run.*` field passes through verbatim

- **WHEN** a node's `with.prompt` is
  `"Run id: {{ run.id }}."` and the runner's `runCwd` is set
- **THEN** the executor receives `with.prompt` equal to
  `"Run id: {{ run.id }}."` (verbatim, no error)

#### Scenario: `{{ run.outputs_dir }}` substitutes to the per-node dir

- **WHEN** a node's `with.prompt` is
  `"Write findings to {{ run.outputs_dir }}/findings.json."` and
  the node is iteration 1 of `propose` in run `abcd1234...`
- **THEN** the executor receives `with.prompt` equal to
  `"Write findings to ~/.minifac/outputs/abcd1234.../propose/1/findings.json."`
  (with the home tilde expanded to the absolute path)

#### Scenario: `{{ run.outputs_dir }}` substitutes in cwd

- **WHEN** a node's `cwd` is `"{{ run.outputs_dir }}"`
- **THEN** the executor receives `cwd` equal to the absolute
  per-node-per-iteration outputs directory path; the directory
  exists when the executor opens it

#### Scenario: `{{ inputs.<field> }}` substitutes a string input value

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { change: "foo" }`, and the node's `with.prompt` (sourced
  from the step body) is `"Work on {{ inputs.change }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Work on foo."`

#### Scenario: `{{ inputs.<field> }}` stringifies a number

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { iterations: 3 }`, and the node's `with.prompt` is
  `"Run {{ inputs.iterations }} times."`
- **THEN** the executor receives `with.prompt` equal to
  `"Run 3 times."`

#### Scenario: `{{ inputs.<field> }}` stringifies a boolean

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { dry_run: true }`, and the node's `with.prompt` is
  `"Dry run: {{ inputs.dry_run }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Dry run: true."`

#### Scenario: `{{ inputs.<field> }}` stringifies an array as JSON

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { commands: ["npm test", "npm run build"] }`, and the
  node's `with.prompt` is `"Commands: {{ inputs.commands }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Commands: [\"npm test\",\"npm run build\"]."`

#### Scenario: `{{ inputs.<field> }}` with an absent optional input substitutes empty string

- **WHEN** a node was inlined from a step that declares
  `model: { type: "string" }` (optional, no default) and the
  factory's node-level `inputs:` did not supply `model`, and the
  node's `with.prompt` is `"Model: {{ inputs.model }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Model: ."`

#### Scenario: `{{ inputs.<field> }}` on an inline node passes through verbatim

- **WHEN** a node was NOT inlined from a step (declared inline
  `executor:` + `with:`) and the node's `with.prompt` is
  `"Foo: {{ inputs.bar }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Foo: {{ inputs.bar }}."` (verbatim, no error)

#### Scenario: `{{ inputs.<field> }}` and `{{ brief.<field> }}` cooperate

- **WHEN** a factory node declares `uses: minifac:openspec-propose`
  with `inputs: { change: "{{ brief.change }}" }`, and the step's
  body contains `"Work on {{ inputs.change }}."`, and the run's
  brief has `change: "foo"`
- **THEN** at load time the step is inlined with the input value
  preserved as the literal token string `"{{ brief.change }}"`
  (since the brief is not in scope at load); at dispatch time the
  runner first substitutes `{{ inputs.change }}` to the literal
  `"{{ brief.change }}"`, then a subsequent pass substitutes
  `{{ brief.change }}` to `"foo"`; the executor receives
  `with.prompt` equal to `"Work on foo."`

#### Scenario: Inputs substitution preserves null/undefined values as empty string

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { note: null }` (explicit null) and the node's
  `with.prompt` is `"Note: {{ inputs.note }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Note: ."`

#### Scenario: `{{ priorResults.<id>.outputs.<key> }}` substitutes the absolute path

- **WHEN** node `propose` ran iteration 1 and produced a present
  `findings` value output at
  `~/.minifac/outputs/abc.../propose/1/findings.json`, and a
  later node's `with.prompt` is
  `"Read {{ priorResults.propose.outputs.findings }} for context."`
- **THEN** the executor receives `with.prompt` equal to
  `"Read ~/.minifac/outputs/abc.../propose/1/findings.json for context."`
  (with the home tilde expanded to the absolute path)

#### Scenario: `:read` suffix inlines small file contents

- **WHEN** node `propose` produced a 2 KB `findings.json` and a
  later node's `with.prompt` is
  `"Findings:\n{{ priorResults.propose.outputs.findings:read }}\nEnd."`
- **THEN** the executor receives `with.prompt` with the literal
  JSON contents of `findings.json` spliced into the prompt
  between the `Findings:\n` and `\nEnd.` markers

#### Scenario: `:read` suffix on oversize file throws

- **WHEN** node `propose` produced a 200 KB `findings.json` and
  a later node's `with.prompt` contains
  `{{ priorResults.propose.outputs.findings:read }}`
- **THEN** the substitution pass throws a template-substitution
  error naming the node id (`propose`), the output key
  (`findings`), the actual size (`200000+ bytes`), and the cap
  (`65536 bytes`); the node is not dispatched

#### Scenario: `:read` on a directory output throws

- **WHEN** a node's `with.prompt` contains
  `{{ priorResults.verify.outputs.logs:read }}` and the `logs`
  output is declared `type: "directory"`
- **THEN** the substitution pass throws a template-substitution
  error naming the output key and explaining that `:read` is
  not valid for directory outputs

#### Scenario: `{{ priorResults.<id>.outputs.<key> }}` with no prior result substitutes empty

- **WHEN** a node's `with.prompt` contains
  `{{ priorResults.nonexistent.outputs.findings }}` and no node
  named `nonexistent` has run yet (or the run has no
  priorResults at all)
- **THEN** the substitution substitutes the empty string; no
  error is raised

#### Scenario: Latest iteration wins

- **WHEN** node `verify` ran iteration 1 (produced `results.json`
  with 3 entries) and iteration 2 (produced a different
  `results.json` with 1 entry), and a downstream node's
  `with.prompt` contains
  `{{ priorResults.verify.outputs.results:read }}`
- **THEN** the substitution inlines the contents of iteration 2's
  `results.json` (the latest), not iteration 1's

### Requirement: Prior-results accumulate across node executions

The runner SHALL maintain an ordered, run-wide array of structured
`NodeResult` entries — one entry per completed node execution,
appended in completion order at the moment the executor's event
stream drains and the node's terminal status is resolved. Each
entry SHALL have exactly the following shape:

```ts
{
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  reason: string | null;   // sentinel REASON when failed; null otherwise
  startedAt: number;       // ms since run start
  endedAt: number;         // ms since run start
  outputs: NodeOutputIndex | null;  // per the "NodeResult.outputs" requirement
}
```

When a node is scheduled, the runner SHALL pass a read-only,
frozen snapshot of the `priorResults` array through the executor's
run context as `ctx.priorResults`. Subsequent iterations of the
same node in a cycle SHALL therefore receive their own prior
result entries (and the entries of every other node that ran in
between).

The `reason` field SHALL be populated from the executor's terminal
`status` event `meta` payload: when `meta.reason === "sentinel_failed"`
and `meta.sentinel` is a string, `reason` SHALL be that string
(trimmed of trailing whitespace). When the runner overrides a
node's terminal status to `failed` due to missing required outputs
(per the "Post-execution outputs validation" requirement),
`reason` SHALL be the string `missing_required_output`. In all
other cases (successful executions, non-sentinel non-output
failures), `reason` SHALL be `null`.

The `outputs` field SHALL be populated per the
"`NodeResult.outputs` field on prior results" requirement: a
populated `NodeOutputIndex` for satisfied outputs on succeeded
nodes; `null` otherwise.

Skipped nodes (those that hit the `max_iterations` budget at pop
time and were not actually dispatched to an executor) SHALL NOT
contribute an entry to `priorResults`.

The runner SHALL NOT pass the raw per-event run history through
the run context. The `onEvent` streaming consumer SHALL continue
to receive every event in real time, unchanged.

#### Scenario: Prior-results accumulate across nodes

- **WHEN** node A runs and completes with `succeeded` after
  emitting two stdout events, then node B is scheduled
- **THEN** the run context passed to B contains `priorResults`
  with exactly one entry: `{ nodeId: "A", iteration: 1,
  status: "succeeded", reason: null, startedAt: <ms>,
  endedAt: <ms>, outputs: null }` (the `outputs` field defaults
  to `null` when A declared no outputs)

#### Scenario: A node's second iteration sees its first iteration's result

- **WHEN** node P runs (iteration 1) and succeeds, then node V
  runs and fails with a sentinel REASON of `"verify hit error"`,
  then the runner cycles back to P for iteration 2
- **THEN** the run context passed to P on iteration 2 contains
  `priorResults` with two entries in order: P iter 1 (status
  `succeeded`, `reason: null`, `outputs: null`), then V iter 1
  (status `failed`, `reason: "verify hit error"`,
  `outputs: null`)

#### Scenario: Prior-results snapshot is stable for the duration of a node run

- **WHEN** node A is running and node B (running concurrently in
  a future fan-out) completes
- **THEN** A's `priorResults` snapshot does not change mid-run;
  A sees only the entries that existed when it was scheduled.
  (v0 is single-flight, so this is trivially true; the rule is
  documented to bind future fan-out.)

#### Scenario: Non-sentinel failure records null reason

- **WHEN** a node fails via non-zero exit code with no
  `MINIFAC_STATUS:` sentinel in the final result event
- **THEN** the entry appended to `priorResults` has `status:
  "failed"`, `reason: null`, and `outputs: null`

#### Scenario: Missing-required-output override records the named reason

- **WHEN** a node terminates `succeeded` at the executor layer
  but the outputs validator overrides it to `failed` because a
  required output is missing
- **THEN** the entry appended to `priorResults` has `status:
  "failed"`, `reason: "missing_required_output"`, and
  `outputs: null` (the partial index lives on the per-execution
  failure metadata, not on the prior-results snapshot)

#### Scenario: Successful execution with satisfied outputs records the index

- **WHEN** a node terminates `succeeded` with both required
  outputs satisfied
- **THEN** the entry appended to `priorResults` has `status:
  "succeeded"`, `reason: null`, and `outputs` populated with
  the `NodeOutputIndex` of present-and-satisfied keys

#### Scenario: Skipped node is not appended

- **WHEN** node P has `max_iterations: 2` and has already
  executed twice, and the runner pops a third scheduled
  occurrence of P from its queue
- **THEN** the runner skips P without dispatch and SHALL NOT
  append a `priorResults` entry for that skipped occurrence
