## MODIFIED Requirements

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
- `run.<field>` where `<field>` is `cwd`. Other identifiers under
  the `run` namespace are reserved for future fields; today they
  pass through verbatim per the runner's substitution rules.

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
