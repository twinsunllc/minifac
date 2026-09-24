## ADDED Requirements

### Requirement: Split run-context tokens and preamble block

The runner SHALL accept two optional, mutually independent run options,
both passed through without interpretation:

```ts
split?: {                      // a split child; null/absent otherwise
  parent_work_item_id: string;
  parent_jira_key: string | null;
  parent_branch: string;
  child_index: number;         // 1-based
  child_count: number;
  group: unknown[];
} | null;
splitIntegration?: {           // a resumed split parent; null/absent otherwise
  children: unknown[];
  unmerged_sub_tasks: unknown[];
} | null;
```

Neither option SHALL change which nodes are dispatched, nor how a
resumed run is seeded.

The simple namespace token grammar SHALL additionally accept an
optional dotted sub-path after the field: zero or more of literal `.`
followed by an identifier matching `[a-zA-Z_][a-zA-Z0-9_]*`. A
sub-path SHALL resolve only under `run.split` and
`run.split_integration`. Any other token that carries a sub-path, in
any namespace, SHALL pass through verbatim, both at dispatch time and
at step-inlining time; step inlining SHALL also leave
`{{ run.split* }}` tokens verbatim.

When a run scope is in effect, the runner SHALL resolve, for EVERY run:

1. `{{ run.split }}` and `{{ run.split_integration }}` — the object as
   `JSON.stringify` output, or `null` when the option is absent or null.
2. `{{ run.split.<key>[.<key>...] }}` and
   `{{ run.split_integration.<key>[.<key>...] }}` — walk plain-object
   keys; render a string as-is, a number or boolean via `String`, and
   an object or array as JSON. A missing key, a null value, an absent
   object, or a step through a non-object (an array included, so there
   is no indexing) SHALL render the empty string.

For a run with `split` or `splitIntegration` set, the runner SHALL
prepend a run-context block, followed by a blank line, to the
substituted `with.prompt` of every dispatch whose node has a string
`with.prompt`: a section headed `## Split child (run.split)` when
`split` is set, then one headed
`## Split integration (run.split_integration)` when `splitIntegration`
is set, each carrying the object as fenced JSON. A resume seed's
`## Human answer (resume)` block SHALL still be appended after the
prompt. For a run with neither option, the runner SHALL prepend no
block. A node without a string `with.prompt` SHALL be
dispatched with its `with` unchanged. The claude executor's
`priorResults` stdin preamble SHALL NOT change.

#### Scenario: A split child resolves its fields and gets the block

- **WHEN** a run is started with `split` whose `parent_branch` is
  `factory/parent` and `child_index` is `2`, and a node's prompt is
  `"base=[{{ run.split.parent_branch }}] i={{ run.split.child_index }}"`
- **THEN** the executor's prompt starts with the
  `## Split child (run.split)` block holding the JSON of `split`, and
  ends with `"base=[factory/parent] i=2"`

#### Scenario: An ordinary run renders null and empty, with no block

- **WHEN** a run with neither `split` nor `splitIntegration`
  dispatches a node whose prompt is
  `"s={{ run.split }} b=[{{ run.split.parent_branch }}] si={{ run.split_integration }}"`
- **THEN** the executor receives exactly `"s=null b=[] si=null"`

#### Scenario: A resumed split parent carries both blocks

- **WHEN** a run is resumed at `implement` with feedback and
  `splitIntegration`, and `implement`'s prompt is
  `"s={{ run.split }} c={{ run.split_integration.children }}"`
- **THEN** the prompt starts with the
  `## Split integration (run.split_integration)` block, carries
  `s=null` and the JSON of `children`, and ends with the
  `## Human answer (resume)` block

#### Scenario: Other dotted tokens stay verbatim

- **WHEN** a prompt contains `{{ brief.change.x }}`, `{{ inputs.a.b }}`
  or `{{ run.cwd.x }}`
- **THEN** each passes through verbatim

#### Scenario: A missing key renders the empty string

- **WHEN** a split child's prompt contains `{{ run.split.nope }}` or
  `{{ run.split.group.length }}`
- **THEN** each renders the empty string
