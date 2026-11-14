## ADDED Requirements

### Requirement: Brief start_branch token

The runner SHALL resolve the brief token `{{ brief.start_branch }}` in the
same places, and by the same grammar, as `{{ brief.base_branch }}`. It SHALL
substitute the string value of the brief frontmatter's `start_branch` when the
brief carries one, and the empty string when it does not. It SHALL NOT leave
the token verbatim when a brief is in scope.

`start_branch` names the branch a run's working branch was cut from when the
order named one apart from its `base_branch` (Scarif SCARIFW-3040).
`brief.base_branch` keeps naming the branch the run's pull request targets.

#### Scenario: A brief carrying start_branch

- **WHEN** a node's `with.prompt` is
  `"Start: {{ brief.start_branch }}; base: {{ brief.base_branch }}."` and the
  run's brief has `start_branch: office/x` and `base_branch: main`
- **THEN** the executor receives `with.prompt` equal to
  `"Start: office/x; base: main."`

#### Scenario: A brief without start_branch

- **WHEN** a node's `with.prompt` is `"Start: [{{ brief.start_branch }}]."`
  and the run's brief omits `start_branch`
- **THEN** the executor receives `with.prompt` equal to `"Start: []."`
