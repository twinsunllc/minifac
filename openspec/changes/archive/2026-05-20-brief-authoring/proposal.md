## Why

Briefs are now the unit of input to a factory (decisions
[`0004-Factory-vs-Input-Separation`](../../../docs/decisions/0004-Factory-vs-Input-Separation.md)
and [`0005-Brief-Schema`](../../../docs/decisions/0005-Brief-Schema.md)),
but there is no minifac-native tooling that helps an author turn vague
intent into a sharp brief. Today users hand-write `inputs/<change>.md`
in any editor and lean on an external conversational tool to refine it.
The roadmap lists `brief-authoring` as the phase-2 ergonomic that
removes that dependency — a one-question-at-a-time helper that walks
the user from "I want to do X" to a brief that loads cleanly through
the existing `brief-schema` loader.

The conversational refinement is the heart of the work. The helper
asks one focused question at a time, adapts the next question to the
last answer, and writes a brief that conforms to the schema the
runner already validates. Two surfaces ship in parallel: a Claude Code
skill (the AI-assisted, recommended path) and an offline CLI verb (a
scripted / no-Claude fallback).

## What Changes

- **NEW** `.claude/skills/brief-authoring/SKILL.md` — a Claude Code
  skill that activates when the user invokes `/brief <name>` or asks
  Claude Code to "write a brief for X." The skill follows a strict
  one-question-at-a-time flow (change name → factory → background →
  what to do → out of scope → acceptance criteria → optional
  frontmatter), waits for each answer, adapts the next question, and
  consults the canonical specs / decision notes when the user mentions
  spec capabilities. On completion it writes the brief to
  `inputs/<change>.md`. The user can stop at any time and the skill
  saves what it has, marked as incomplete.
- **NEW** `minifac brief <name>` CLI subcommand with two modes:
  - **Interactive** (default): drops into a TTY-based readline flow
    that walks the same question list in series and writes the
    answers into `inputs/<name>.md`. No Claude API calls.
  - **Non-interactive** (`--from <file>`): reads answers from a YAML
    or JSON file matching the shared question schema and writes the
    same template-shaped output. Useful for scripted brief generation.
  - Optional `--out <path>` overrides the default `inputs/<name>.md`
    destination.
- **NEW** shared question schema under `src/brief/authoring.ts`
  (or co-located in `src/brief/`) that both surfaces consult. Each
  question has an id, prompt text, default (where sensible), required
  flag, and a mapping that says how the answer renders into the
  brief's frontmatter or body. The CLI iterates the schema; the
  Claude Code skill references it (by relative file path) so the two
  surfaces stay in lockstep.
- **NEW** validity contract: a brief produced by either surface
  SHALL round-trip through `loadBrief` without error. The CLI verb
  asserts this at write time (loads the file it just wrote and exits
  non-zero if the load fails).
- **NEW** tests under `src/brief/` and `src/cli/` cover the question
  schema, the CLI's interactive flow (scripted-stdin harness), the
  CLI's `--from` mode (fixture-driven), a snapshot of the produced
  brief shape, and the round-trip-through-`loadBrief` invariant.
- **DOCS** `docs/concepts/Brief.md` and `README.md` updated to point
  at the new authoring surfaces; `examples/sdd.md` mentions
  `minifac brief` as the recommended way to start a new SDD-driven
  change.

This change is **non-breaking**. The brief schema is unchanged. The
existing `minifac run` and brief loader are unchanged. The Claude
Code skill is additive (it sits next to the existing
`openspec-propose` skill); the CLI subcommand is additive (it sits
next to `run`, `prune`, and `serve`).

## Capabilities

### New Capabilities

- `brief-authoring`: the question schema (the ordered list of
  prompts a brief-authoring helper walks through), the output
  contract (`inputs/<change>.md`, frontmatter shape per
  `brief-schema`, recommended body section structure), the
  round-trip-validity guarantee, the partial-brief behavior, and
  the two transport surfaces (Claude Code skill, CLI verb).

### Modified Capabilities

- `run-cli`: adds a new `minifac brief` subcommand with its
  interactive and `--from` modes, alongside the existing `run`,
  `prune`, and `serve` subcommands.

## Impact

- `.claude/skills/brief-authoring/` (new): `SKILL.md` plus any
  supporting files. Follows the same metadata shape as
  `.claude/skills/openspec-propose/SKILL.md`.
- `src/brief/authoring.ts` (new): the shared question schema and the
  pure render function (`answers → BriefFileContent`).
- `src/brief/authoring.test.ts` (new): unit tests on the schema and
  the render function.
- `src/cli/brief.ts` (new): the `brief` subcommand action — interactive
  TTY flow (readline) and `--from <file>` non-interactive mode.
- `src/cli/brief.test.ts` (new): tests for both modes, including a
  scripted stdin harness for interactive mode and a fixture-driven
  test for `--from`.
- `src/cli.ts`: register the new `brief` subcommand on the
  `commander` `program`. No changes to the existing subcommands.
- `docs/concepts/Brief.md`: short subsection naming the two
  authoring surfaces and pointing at `examples/sample-brief.md` as
  the template they produce.
- `examples/sdd.md`: one-paragraph mention of `minifac brief` as the
  starting point for a new change.
- `README.md`: a couple of lines under the "Run the example" section
  showing the two ways to author a brief (`/brief <name>` in Claude
  Code, or `minifac brief <name>` from the terminal).
- No new runtime dependencies. The interactive CLI mode uses the
  Node `node:readline/promises` API; `--from` parsing reuses the
  existing `yaml` package (and `JSON.parse` for `.json`).
- Out of scope (deferred): auto-running the factory after authoring,
  multi-line / rich-text editing in the CLI verb, brief dependencies
  and other future frontmatter fields, AI-driven generation in the
  CLI verb itself (no Claude API calls from the verb), and any
  templating beyond the recommended sections. See
  [`docs/Roadmap.md`](../../../docs/Roadmap.md) for where these
  belong.
