## ADDED Requirements

### Requirement: Brief token substitution before node dispatch

The runner SHALL accept an optional `brief` argument identifying the
brief that initiated the run. When a brief is in scope, the runner
SHALL substitute brief fields into each scheduled node's
`with.prompt` string (if and only if `with.prompt` is a string)
immediately before dispatching the node to its executor.

The token grammar SHALL be: literal `{{`, optional ASCII whitespace,
literal `brief.`, an identifier matching `[a-zA-Z_][a-zA-Z0-9_]*`,
optional ASCII whitespace, literal `}}`. The runner SHALL match this
grammar globally across the prompt string.

Field resolution rules per matched token:

- For `change`, `body`, `factory`: substitute the corresponding string
  value from the resolved brief. These fields are always present on a
  resolved brief.
- For `base_branch`, `model`: substitute the string value if present
  on the brief; otherwise substitute the empty string.
- For any other identifier: leave the token verbatim in the prompt
  string (no error, no substitution).

When the run has no brief (e.g. a `brief: "none"` factory invoked
brief-less), the runner SHALL NOT substitute any tokens; prompts pass
through to executors unchanged. The factory author opting into
`brief: "none"` is responsible for ensuring prompts do not depend on
substitution.

Substitution SHALL happen in the runner, not in the executor. The
executor sees the resolved prompt string with no tokens (when a brief
is in scope) or the verbatim prompt (when none is). The executor
interface and its `with:` validation are unchanged by this
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

#### Scenario: Brief-less run leaves tokens verbatim

- **WHEN** a node's `with.prompt` contains `{{ brief.change }}` and
  the run has no brief in scope (brief-less factory invocation)
- **THEN** the executor receives `with.prompt` with the token preserved
  verbatim; the executor's existing validation behavior applies to the
  unchanged string

#### Scenario: Non-string `with.prompt` is left alone

- **WHEN** a node's `with.prompt` is not a string (or the node has no
  `with.prompt` at all)
- **THEN** the runner performs no substitution on that node; the
  executor's existing `with:` validation applies as today
