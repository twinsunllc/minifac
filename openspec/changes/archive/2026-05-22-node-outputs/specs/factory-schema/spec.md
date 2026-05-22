## ADDED Requirements

### Requirement: Node `outputs:` block

A factory node MAY declare an `outputs:` field whose value SHALL
be an object whose keys match the regex
`^[a-zA-Z_][a-zA-Z0-9_]*$` (the same identifier grammar used for
step input keys, per the `step-schema` capability) and whose
values SHALL be discriminated `OutputDef` objects per the next
requirement.

The `outputs:` field SHALL be optional. A node without an
`outputs:` field SHALL behave identically to today: no outputs
are declared, no required-output validation runs against that
node, and `NodeResult.outputs` is `null` for that node's
executions.

When `outputs:` is present, the accepted node-level key set
SHALL be extended to include `outputs` (see the modified "Node
definition" requirement below). Strict-on-extras at the node
level SHALL continue to reject any other unknown key.

#### Scenario: Node without `outputs:` loads as before

- **WHEN** the loader reads a factory whose nodes declare no
  `outputs:` field
- **THEN** validation succeeds; each node's resolved shape has
  no `outputs` property (or carries `outputs: undefined`),
  byte-equivalent to today's pre-change behavior

#### Scenario: Node with valid `outputs:` loads

- **WHEN** the loader reads a factory whose node declares
  `outputs: { findings: { type: "value", required: true },
  report: { type: "file", filename: "report.md" } }`
- **THEN** validation succeeds; the resolved node carries the
  declared `outputs` map with both keys preserved verbatim

#### Scenario: Output key with invalid identifier is rejected

- **WHEN** the loader reads a node whose `outputs:` key is
  `"123findings"` or `"findings-1"` (starts with a digit or
  contains a hyphen)
- **THEN** validation fails with an error naming the node id and
  the offending key

#### Scenario: Empty `outputs:` object is accepted

- **WHEN** the loader reads a node whose `outputs:` is the empty
  object `{}`
- **THEN** validation succeeds; the resolved node carries an
  empty outputs map (no declared outputs to validate at runtime)

### Requirement: `OutputDef` discriminated types

Each value in a node's `outputs:` map SHALL be a discriminated
union on the `type` field, with three accepted values:

- **`type: "value"`** — a JSON-encoded value the model writes to
  `<outputs_dir>/<key>.json`. The schema SHALL accept the
  following sibling fields: `required` (boolean, default
  `false`), `description` (optional string), and `shape`
  (optional, value reserved for future structural typing —
  the schema accepts any value here today and the runtime
  validator ignores it; this reservation lets factory authors
  add structural typing in a future change without rewriting
  the factory).
- **`type: "file"`** — a file the model writes inside
  `<outputs_dir>`. The schema SHALL accept: `required`
  (boolean, default `false`), `description` (optional string),
  `filename` (optional string). When `filename:` is present, it
  SHALL be a non-empty string with no path separators (i.e.
  the file lives at the top of `outputs_dir`). When absent,
  the validator at runtime discovers the file by globbing
  `<key>.*` inside `outputs_dir`.
- **`type: "directory"`** — a directory the model populates at
  `<outputs_dir>/<key>/`. The schema SHALL accept: `required`
  (boolean, default `false`), `description` (optional string).

Each `OutputDef` SHALL be strict on extras within its branch:
fields not listed above SHALL be rejected with an error naming
the offending key, the output key, and the node id.

A `type` value other than the three listed SHALL be rejected
with an error listing the supported types.

#### Scenario: `type: "value"` with all optional fields loads

- **WHEN** the loader reads a node with output `findings:
  { type: "value", required: true, description: "code review
  findings" }`
- **THEN** validation succeeds; the resolved output carries all
  three fields

#### Scenario: `type: "value"` with reserved `shape:` field accepted

- **WHEN** the loader reads a node with output `findings:
  { type: "value", shape: { items: "array" } }`
- **THEN** validation succeeds; the resolved output carries
  `shape` verbatim (the runtime validator ignores it today;
  the reservation is documented in the design)

#### Scenario: `type: "file"` with explicit filename loads

- **WHEN** the loader reads a node with output `patch:
  { type: "file", filename: "patch.diff", required: true }`
- **THEN** validation succeeds; the resolved output carries the
  filename

#### Scenario: `type: "file"` with filename containing a path separator is rejected

- **WHEN** the loader reads a node with output `patch:
  { type: "file", filename: "sub/patch.diff" }`
- **THEN** validation fails with an error naming the node id,
  the output key, and the `filename` field

#### Scenario: `type: "file"` with empty filename is rejected

- **WHEN** the loader reads a node with output `patch:
  { type: "file", filename: "" }`
- **THEN** validation fails with an error naming the node id,
  the output key, and the `filename` field

#### Scenario: `type: "directory"` loads with description

- **WHEN** the loader reads a node with output `logs:
  { type: "directory", required: false, description: "test
  output logs" }`
- **THEN** validation succeeds

#### Scenario: Unknown `type` is rejected

- **WHEN** the loader reads a node with output `x:
  { type: "blob" }`
- **THEN** validation fails with an error listing the supported
  types (`value`, `file`, `directory`)

#### Scenario: Unknown sibling field within an OutputDef branch is rejected

- **WHEN** the loader reads a node with output `findings:
  { type: "value", maxBytes: 1024 }` (where `maxBytes` is not
  in the value-branch schema)
- **THEN** validation fails with an error naming the node id,
  the output key, and the offending field name

#### Scenario: Output `required` defaults to false

- **WHEN** the loader reads a node with output `findings:
  { type: "value" }` (no `required:` declared)
- **THEN** the resolved output carries `required: false`

### Requirement: Reserved `run.outputs_dir` template token

The factory schema SHALL reserve `run.outputs_dir` as a valid
field under the `run` namespace in the `{{ run.<field> }}` token
grammar, alongside `run.cwd`. As with
`run.cwd`, the schema's responsibility is to leave the token
verbatim in `with.prompt` and `cwd` strings; the `graph-runner`
capability performs the substitution at dispatch time (per its
"Brief token substitution" requirement, which this change also
modifies).

The reserved `run.<field>` field set is therefore: `cwd`,
`outputs_dir`. Other identifiers under the `run` namespace
remain reserved for future fields and pass through verbatim
today per the runner's substitution rules.

#### Scenario: Prompt with `{{ run.outputs_dir }}` loads without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes
  has `with.prompt: "Write findings to {{ run.outputs_dir }}/findings.json."`
- **THEN** the loader returns a typed factory object without
  error; the prompt string is preserved verbatim with the token
  intact (substitution happens at runtime)

#### Scenario: cwd with `{{ run.outputs_dir }}` loads without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes
  has `cwd: "{{ run.outputs_dir }}"`
- **THEN** the loader returns a typed factory object without
  error; the cwd string is preserved verbatim with the token
  intact

## MODIFIED Requirements

### Requirement: Node definition

Each node SHALL declare an `executor` (string identifying a registered
runner, e.g. `claude`). It MAY declare `terminal` (boolean, default
`false`), `max_iterations` (positive integer), `cwd` (string),
`with` (free-form object passed verbatim to the executor), and
`outputs` (see the "Node `outputs:` block" requirement).

A node MAY alternatively declare `uses:` + `inputs:` instead of
inline `executor:` + `with:` (see the "Node `uses:` field as an
alternative to inline executor" requirement). The accepted
node-level key set is: `executor`, `with`, `uses`, `inputs`,
`terminal`, `max_iterations`, `cwd`, `outputs`. Any other key
SHALL be rejected with an error naming the offending key and the
node id.

The `outputs:` field is independent of executor vs. step choice:
nodes that declare `uses:` MAY also declare `outputs:`, and the
loader SHALL preserve `outputs:` through step inlining unchanged
(the step body has no opinion on what a node declares as its
outputs).

#### Scenario: Node without executor fails validation

- **WHEN** a node definition is missing the `executor` key
- **THEN** validation fails with an error identifying the node id and the
  missing field

#### Scenario: Unknown top-level node keys are rejected

- **WHEN** a node defines a key not in the schema envelope (e.g. `retry`)
- **THEN** validation fails. (Executor-specific keys belong under `with:`.)

#### Scenario: `with:` is opaque to the schema

- **WHEN** a node declares `with: { prompt: "hello" }`
- **THEN** the schema accepts the node regardless of `with` contents;
  per-executor validation of `with` happens inside the executor

#### Scenario: Node declares `outputs:` alongside `executor:` + `with:`

- **WHEN** a node declares `executor: claude`, `with: { prompt: "..." }`,
  and `outputs: { findings: { type: "value", required: true } }`
- **THEN** the schema accepts the node; the resolved node carries
  the `outputs` map verbatim

#### Scenario: Node declares `outputs:` alongside `uses:` + `inputs:`

- **WHEN** a node declares `uses: minifac:openspec-propose`,
  `inputs: { change: "foo" }`, and
  `outputs: { plan: { type: "file", filename: "plan.md" } }`
- **THEN** the schema accepts the node; after step inlining the
  resolved node carries the `outputs` map verbatim alongside the
  inlined `executor` and `with`

### Requirement: Reserved brief template tokens in node prompts

The factory schema SHALL reserve the token shape
`{{ <ns>.<field> }}` inside both node `with.prompt` strings AND
node `cwd` strings for runtime substitution by the `graph-runner`
capability. The recognized namespaces are `brief` and `run`. The
schema SHALL NOT enforce whether tokens are present or which
fields they reference; substitution is the `graph-runner`
capability's responsibility (see that spec's "Brief token
substitution" requirement). Factory authors SHALL NOT rely on a
token of either shape passing through to the executor as a literal
string unless the factory declares `brief: "none"` (for
`{{ brief.* }}`) AND the run does not supply a `runCwd` (for
`{{ run.* }}`).

The reserved field sets are:

- `brief.<field>` where `<field>` is one of `change | body |
  factory | base_branch | model`. Other identifiers under the
  `brief` namespace are reserved for future fields; today they
  pass through verbatim per the runner's substitution rules.
- `run.<field>` where `<field>` is one of `cwd | outputs_dir`.
  Other identifiers under the `run` namespace are reserved for
  future fields; today they pass through verbatim per the
  runner's substitution rules.

The set of fields a factory author is permitted to template SHALL
NOT differ between `with.prompt` and `cwd` — both accept any
token in the reserved grammar. The substitution semantics
(including the empty-string default for absent optional brief
fields and the leave-verbatim default for unknown identifiers)
are identical across both target fields, per the `graph-runner`
spec.

#### Scenario: Prompts with template tokens load without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `with.prompt: "Work on {{ brief.change }}.\n\n{{ brief.body }}"`
- **THEN** the loader returns a typed factory object without error;
  the prompt string is preserved verbatim with tokens intact

#### Scenario: Prompts without template tokens are unaffected

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `with.prompt: "Say hello in one sentence."`
- **THEN** the loader returns a typed factory object without error;
  the prompt string is preserved verbatim

#### Scenario: cwd with `{{ run.cwd }}` loads without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `cwd: "{{ run.cwd }}"`
- **THEN** the loader returns a typed factory object without error;
  the `cwd` string is preserved verbatim with the token intact

#### Scenario: cwd with `{{ brief.change }}` loads without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `cwd: "/repos/{{ brief.change }}"`
- **THEN** the loader returns a typed factory object without error;
  the `cwd` string is preserved verbatim with the token intact

#### Scenario: Literal cwd is unaffected

- **WHEN** the loader reads a factory YAML one of whose nodes has
  `cwd: "/explicit/path"`
- **THEN** the loader returns a typed factory object without error;
  the `cwd` string is preserved verbatim with no token in it

#### Scenario: Prompts with `{{ run.outputs_dir }}` load without schema error

- **WHEN** the loader reads a factory YAML one of whose nodes
  has `with.prompt: "Write findings to {{ run.outputs_dir }}/findings.json."`
- **THEN** the loader returns a typed factory object without
  error; the prompt string is preserved verbatim with the token
  intact (substitution happens in `graph-runner` at dispatch
  time)
