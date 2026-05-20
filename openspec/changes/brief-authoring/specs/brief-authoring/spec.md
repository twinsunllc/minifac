## ADDED Requirements

### Requirement: Shared question schema

A single source-of-truth question schema SHALL define the ordered set
of questions a brief-authoring helper walks through. The schema SHALL
live in `src/brief/authoring.ts` and SHALL export an immutable ordered
list of question records together with a typed union of question
identifiers. Each question record SHALL declare at least:

- `id`: the question identifier (typed union literal),
- `prompt`: the human-facing prompt text,
- `required`: a boolean indicating whether an answer is mandatory,
- `applies`: either `"frontmatter"` or `"body-section"` indicating
  how the answer renders into the produced brief,
- when `applies === "frontmatter"`, the target frontmatter key
  (one of `change`, `factory`, `base_branch`, `model`, `mode`),
- when `applies === "body-section"`, the markdown heading the
  answer renders under (e.g. `## Background`).

The v0 schema SHALL contain the following questions in this exact
order, with the marked required / optional flags:

| Order | id                    | applies      | required | renders into                             |
|-------|-----------------------|--------------|----------|------------------------------------------|
| 1     | `change`              | frontmatter  | yes      | `change:`                                |
| 2     | `factory`             | frontmatter  | yes      | `factory:` (default `sdd`)               |
| 3     | `background`          | body-section | yes      | `## Background`                          |
| 4     | `what_to_do`          | body-section | yes      | `## What to do`                          |
| 5     | `out_of_scope`        | body-section | no       | `## Out of scope`                        |
| 6     | `acceptance_criteria` | body-section | yes      | `## Acceptance criteria`                 |
| 7     | `base_branch`         | frontmatter  | no       | `base_branch:`                           |
| 8     | `model`               | frontmatter  | no       | `model:`                                 |

Both consumers (the Claude Code skill and the CLI verb) SHALL import
the question identifiers and order from this schema; neither SHALL
hard-code a parallel list.

#### Scenario: Schema enumerates exactly the v0 question set

- **WHEN** code imports the schema module
- **THEN** the exported question list contains exactly the eight
  questions above, in the listed order, with the listed
  required/optional flags and target keys/headings

#### Scenario: Required questions are flagged

- **WHEN** the schema is iterated
- **THEN** the questions with ids `change`, `factory`,
  `background`, `what_to_do`, and `acceptance_criteria` have
  `required === true` and the remaining three have
  `required === false`

### Requirement: Pure renderer produces brief content from answers

The authoring module SHALL export a pure function that takes an
`AuthoringAnswers` record (a partial map of question id to string)
and returns the markdown text of a brief file. The returned text
SHALL:

- start with a YAML frontmatter block delimited by `---` lines, per
  the `brief-schema` capability's "Brief file format" requirement,
- include only the frontmatter keys whose corresponding question
  was answered with a non-empty string (no `base_branch:` line when
  the user did not supply one),
- follow the frontmatter with the body-section answers in canonical
  order, each preceded by a markdown H2 heading matching the
  schema's declared heading for that question, separated from
  surrounding sections by blank lines,
- omit body sections whose corresponding question is optional and
  unanswered.

The renderer SHALL be deterministic: the same input answers SHALL
produce byte-identical output across calls.

#### Scenario: All required answers render a valid brief

- **WHEN** the renderer is called with `{ change: "demo", factory: "sdd", background: "B", what_to_do: "W", acceptance_criteria: "A" }`
- **THEN** the returned text begins with `---\nchange: demo\nfactory: sdd\n---\n` and contains `## Background`, `## What to do`, and `## Acceptance criteria` H2 sections in order with the supplied bodies

#### Scenario: Optional unanswered fields are omitted

- **WHEN** the renderer is called with the required answers above and no `base_branch`, `model`, or `out_of_scope` answer
- **THEN** the produced frontmatter contains no `base_branch:` or `model:` line and the body contains no `## Out of scope` heading

#### Scenario: Optional answered fields appear

- **WHEN** the renderer is called with the required answers above plus `base_branch: "main"` and `out_of_scope: "the moon"`
- **THEN** the frontmatter contains `base_branch: main` and the body contains a `## Out of scope` section whose body is `the moon`

#### Scenario: Renderer is deterministic

- **WHEN** the renderer is called twice with the same `AuthoringAnswers` input
- **THEN** the two return values are byte-identical

### Requirement: Output file path convention

A brief produced by the brief-authoring helper SHALL be written to
`inputs/<change>.md` relative to the CLI's invocation cwd by
default, where `<change>` is the resolved answer to the `change`
question. A caller MAY override this destination via an explicit
output-path argument; the helper SHALL use the explicit path
verbatim when supplied.

The helper SHALL refuse to overwrite an existing file at the
resolved output path unless an explicit `force` flag is supplied,
in which case it SHALL overwrite the file unconditionally.

#### Scenario: Default output is inputs/<change>.md

- **WHEN** the user invokes the brief-authoring helper for change name `my-change` without an explicit output path
- **THEN** the helper writes the brief to `inputs/my-change.md` under the invocation cwd

#### Scenario: Explicit output path is used verbatim

- **WHEN** the user invokes the helper with an explicit output path `/tmp/foo.md`
- **THEN** the helper writes the brief to `/tmp/foo.md`

#### Scenario: Existing file is preserved without --force

- **WHEN** the resolved output path already exists and no force flag is supplied
- **THEN** the helper exits with a usage error naming the existing file and writes nothing

#### Scenario: --force overwrites

- **WHEN** the resolved output path already exists and the force flag is supplied
- **THEN** the helper overwrites the file with the new brief content

### Requirement: Round-trip validity through the brief loader

A brief produced by the brief-authoring helper SHALL load cleanly
through the `loadBrief` function from the `brief-schema` capability.
That is, for any answers satisfying the schema's required-question
constraints, the helper's output, when written to disk and read
back by `loadBrief`, SHALL return a `Brief` whose `frontmatter`
includes at least the answered required fields and whose `body`
contains the answered body sections.

The CLI verb implementation SHALL assert this invariant at runtime:
after writing the brief file, it SHALL invoke `loadBrief` on the
written file and SHALL exit non-zero with the load error if
`loadBrief` throws.

#### Scenario: Produced brief loads cleanly

- **WHEN** the helper writes a brief from answers `{ change: "demo", factory: "sdd", background: "B", what_to_do: "W", acceptance_criteria: "A" }`
- **THEN** invoking `loadBrief` on the written path returns a Brief whose `frontmatter.change === "demo"`, `frontmatter.factory === "sdd"`, and whose body contains the substrings `## Background`, `## What to do`, and `## Acceptance criteria`

#### Scenario: Helper exits non-zero on a load failure of its own output

- **WHEN** the helper's renderer produces a file that `loadBrief` rejects (a regression scenario)
- **THEN** the CLI verb exits non-zero and writes the load error to stderr

### Requirement: Partial-brief behavior on early exit

The helper SHALL handle early exit (the user stops the authoring
flow before answering every required question) according to these
rules:

- If the `change` or `factory` answer is missing (i.e. the user
  stopped before the second required question), the helper SHALL
  exit non-zero without writing any file, with a stderr message
  explaining that the brief lacks the minimum required frontmatter.
- Otherwise, the helper SHALL write a partial brief with whatever
  answers it has. The partial brief SHALL begin its body with an
  incomplete-marker block in markdown blockquote form that names
  the next unanswered required question, of the shape:

  ```markdown
  > **Note:** Brief is incomplete; the authoring helper exited
  > before the `<next-question-id>` question.
  ```

  followed by any body-section answers the user did provide. The
  partial brief SHALL pass `loadBrief` (the body marker does not
  affect schema validity).

The CLI verb's interactive mode SHALL treat EOF, SIGINT (^C), and a
sentinel line (e.g. `:q`) as "user stopped" signals.

#### Scenario: Stop before frontmatter required fields exits without writing

- **WHEN** the user stops before answering both `change` and `factory`
- **THEN** the helper writes no file and exits non-zero with a stderr message naming the missing required fields

#### Scenario: Stop after required frontmatter writes a partial brief

- **WHEN** the user answers `change` and `factory` and then stops before answering `background`
- **THEN** the helper writes a brief whose body begins with the incomplete-marker block naming `background`, the file loads cleanly through `loadBrief`, and the helper exits 0

### Requirement: Two authoring surfaces — Claude Code skill and CLI verb

The brief-authoring capability SHALL be exposed through two
surfaces that share the question schema:

1. A Claude Code skill at `.claude/skills/brief-authoring/SKILL.md`,
   activated by the `/brief <name>` slash command (file at
   `.claude/commands/brief.md`) or by natural-language requests
   such as "write a brief for X." The skill SHALL walk the user
   one question at a time, adapt the next question to the previous
   answer, MAY consult canonical specs under
   `openspec/specs/<capability>/spec.md` when the user names a
   capability, and on completion SHALL write the brief to
   `inputs/<change>.md` using the same frontmatter / body
   structure the CLI verb's renderer produces.
2. A CLI verb (`minifac brief <name>`) exposed by the `run-cli`
   capability, with both an interactive readline-driven mode and
   a non-interactive `--from <file>` mode. The CLI verb SHALL NOT
   invoke an external LLM; it is the offline / scripted authoring
   path.

Both surfaces SHALL produce brief files conforming to the
`brief-schema` capability. Both surfaces SHALL be additive — they
do not replace the existing ability to hand-author briefs in any
editor.

#### Scenario: Claude Code skill activates on slash command

- **WHEN** the user types `/brief my-change` in Claude Code
- **THEN** the brief-authoring skill loads and begins the question flow with `change = "my-change"` pre-filled

#### Scenario: CLI verb is the no-Claude path

- **WHEN** the user invokes `minifac brief my-change` on a machine without network access
- **THEN** the CLI verb runs to completion (interactively or via `--from`) without attempting any HTTP / LLM call
