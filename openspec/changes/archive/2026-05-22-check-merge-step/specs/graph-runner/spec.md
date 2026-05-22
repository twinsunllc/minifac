## MODIFIED Requirements

### Requirement: Brief token substitution before node dispatch

The runner SHALL accept an optional `brief` argument identifying the
brief that initiated the run and an optional `runCwd` argument
carrying the run-level cwd (see the "Run-level cwd resolution"
requirement). The runner SHALL ALSO accept an optional
`runBaseBranch` argument carrying the run's configured base branch
(the branch the worktree was created from, per the
`worktree-management` capability). Together with the per-node inputs
map produced by step inlining (see the `factory-schema` capability's
"Step inlining order" and "Step input validation" requirements),
these form the substitution namespaces the runner offers to each
scheduled node.

For each scheduled node, immediately before dispatching to the
node's executor, the runner SHALL substitute template tokens in
both:

- the node's `with.prompt` field (if and only if it is a string), and
- the node's `cwd` field (if and only if it is a non-empty string), and
- the node's `with.base` field (if and only if it is a string),
  for the benefit of the `check-merge` executor and any future
  executor whose `with:` schema names a string field whose contents
  may carry brief/run/inputs tokens. The runner SHALL apply the
  same substitution grammar to `with.base` as to `with.prompt`.

The token grammar SHALL be: literal `{{`, optional ASCII whitespace,
a namespace identifier (`brief`, `run`, or `inputs`), literal `.`, a
field identifier matching `[a-zA-Z_][a-zA-Z0-9_]*`, optional ASCII
whitespace, literal `}}`. The runner SHALL match this grammar
globally across each target string.

Field resolution rules per matched token:

- `brief.change`, `brief.body`, `brief.factory`: substitute the
  corresponding string value from the resolved brief. These fields
  are always present on a resolved brief.
- `brief.base_branch`, `brief.model`: substitute the string value if
  present on the brief; otherwise substitute the empty string.
- `run.cwd`: substitute the run's `runCwd` value (the worktree path
  or the in-place cwd, as supplied by the CLI) when `runCwd` is in
  scope; otherwise leave the token verbatim.
- `run.base_branch`: substitute the run's `runBaseBranch` value (the
  branch the worktree was created from, per the
  `worktree-management` capability) when `runBaseBranch` is in
  scope and is a non-empty string; substitute the empty string
  when `runBaseBranch` is in scope but is the empty string (in-
  place / brief-less / no-base runs); leave the token verbatim
  when `runBaseBranch` is not in scope at all (e.g. a unit-test
  invocation of `runFactory` that does not supply it).
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
- For any other identifier under a known namespace (e.g.
  `brief.depends_on`, `run.id`): leave the token verbatim in the
  string (no error, no substitution).
- For any token whose namespace is not `brief`, `run`, or `inputs`:
  leave the token verbatim in the string.

When the run has no brief, `brief.*` tokens SHALL be left verbatim.
When the run has no `runCwd` in scope (e.g. a unit-test invocation
of `runFactory` without the CLI sequencing wrapper), `run.cwd`
tokens SHALL be left verbatim. When the run has no `runBaseBranch`
in scope, `run.base_branch` tokens SHALL be left verbatim (matching
`run.cwd`'s convention). When the node has no inputs map (inline
node, not produced by step inlining), `inputs.*` tokens SHALL be
left verbatim.

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

#### Scenario: `{{ run.base_branch }}` substitutes in `with.base`

- **WHEN** a node's `with.base` is `"{{ run.base_branch }}"` and the
  runner's `runBaseBranch` is `"main"`
- **THEN** the executor receives `with.base` equal to `"main"`

#### Scenario: `{{ run.base_branch }}` substitutes inside `with.prompt`

- **WHEN** a node's `with.prompt` is
  `"Probing against {{ run.base_branch }}."` and the runner's
  `runBaseBranch` is `"develop"`
- **THEN** the executor receives `with.prompt` equal to
  `"Probing against develop."`

#### Scenario: `{{ run.base_branch }}` with empty runBaseBranch substitutes empty string

- **WHEN** a node's `with.base` is `"{{ run.base_branch }}"` and the
  runner was invoked with `runBaseBranch: ""` (in-place run, or
  run from a non-worktree base)
- **THEN** the substitution pass replaces the token with the empty
  string, and `with.base` arrives at the executor as the empty
  string (the executor's own `with:` validation determines whether
  this is acceptable)

#### Scenario: `{{ run.base_branch }}` with no runBaseBranch in scope passes through

- **WHEN** a node's `with.base` is `"{{ run.base_branch }}"` and the
  runner was invoked without a `runBaseBranch` argument at all
  (e.g. a unit test of `runFactory` that supplies neither)
- **THEN** the substitution pass leaves the field verbatim as
  `"{{ run.base_branch }}"`; the executor's existing `with:`
  validation applies to the unchanged string

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
