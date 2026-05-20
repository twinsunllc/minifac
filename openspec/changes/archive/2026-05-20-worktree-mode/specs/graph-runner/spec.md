## MODIFIED Requirements

### Requirement: Brief token substitution before node dispatch

The runner SHALL accept an optional `brief` argument identifying the
brief that initiated the run and an optional `runCwd` argument
carrying the run-level cwd (see the "Run-level cwd resolution"
requirement). Together these form the substitution namespaces the
runner offers to each scheduled node.

For each scheduled node, immediately before dispatching to the
node's executor, the runner SHALL substitute template tokens in
both:

- the node's `with.prompt` field (if and only if it is a string), and
- the node's `cwd` field (if and only if it is a non-empty string)

The token grammar SHALL be: literal `{{`, optional ASCII whitespace,
a namespace identifier (`brief` or `run`), literal `.`, a field
identifier matching `[a-zA-Z_][a-zA-Z0-9_]*`, optional ASCII
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
- For any other identifier under a known namespace (e.g.
  `brief.depends_on`, `run.id`): leave the token verbatim in the
  string (no error, no substitution).
- For any token whose namespace is not `brief` or `run`: leave the
  token verbatim in the string.

When the run has no brief, `brief.*` tokens SHALL be left verbatim.
When the run has no `runCwd` in scope (e.g. a unit-test invocation
of `runFactory` without the CLI sequencing wrapper), `run.*` tokens
SHALL be left verbatim.

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

## ADDED Requirements

### Requirement: Run-level cwd resolution

The runner SHALL accept an optional `runCwd` argument. When
`runCwd` is supplied, it SHALL be used as the default cwd for any
scheduled node whose `cwd` field is absent, or whose `cwd` field
resolves to the empty string after substitution.

Resolution order, per node, performed by the runner immediately
before dispatching the node to its executor:

1. Apply template substitution to the node's `cwd` field (if a
   non-empty string). The result is the candidate cwd.
2. If the candidate is a non-empty string, that string is the
   resolved cwd passed to the executor.
3. Otherwise, if `runCwd` is in scope (non-empty), the resolved
   cwd is `runCwd`.
4. Otherwise, the resolved cwd is `undefined` (today's behavior
   when no cwd is supplied; executors interpret per their own
   contract).

When `runCwd` is not supplied (e.g. unit-test invocations of
`runFactory`), step 3 is skipped and the runner's behavior reduces
to today's contract: the executor receives whatever the factory
declared, including `undefined` for nodes that declare no `cwd`.

#### Scenario: Node with literal cwd keeps it

- **WHEN** a node declares `cwd: "/explicit/path"` and the runner
  has `runCwd: "/wt"`
- **THEN** the executor receives `cwd` equal to `"/explicit/path"`
  (the literal value takes precedence over the run-level default)

#### Scenario: Node with `{{ run.cwd }}` token resolves to runCwd

- **WHEN** a node declares `cwd: "{{ run.cwd }}"` and the runner
  has `runCwd: "/wt"`
- **THEN** the executor receives `cwd` equal to `"/wt"`

#### Scenario: Node with no cwd uses runCwd as default

- **WHEN** a node declares no `cwd` field at all and the runner
  has `runCwd: "/wt"`
- **THEN** the executor receives `cwd` equal to `"/wt"`

#### Scenario: Empty-string cwd uses runCwd as default

- **WHEN** a node declares `cwd: ""` (or a cwd value that
  substitutes to the empty string) and the runner has
  `runCwd: "/wt"`
- **THEN** the executor receives `cwd` equal to `"/wt"`

#### Scenario: No runCwd in scope reproduces today's behavior

- **WHEN** the runner is invoked without `runCwd` and a node has
  no `cwd` field
- **THEN** the executor receives `cwd` as `undefined` (the
  pre-this-change default)
