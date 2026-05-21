---
change: brief-authoring
factory: sdd
base_branch: main
---

## Background

The [[Brief]] is now the unit of input to minifac (per
`docs/decisions/0004-Factory-vs-Input-Separation.md` and
`docs/decisions/0005-Brief-Schema.md`). Today briefs are hand-authored
in any editor. There's no minifac-native tooling to walk a user through
producing a sharp brief from a vague intent — that's the friction this
change addresses.

The Roadmap describes the change as:

> `brief-authoring` — Claude Code skill (and/or CLI verb) that does
> one-question-at-a-time refinement of vague intent into a structured
> brief under `inputs/<change>.md`.

The conversational refinement is the heart of it: the helper asks one
focused question at a time, lets the user respond, and incrementally
sharpens the brief until it's ready to feed to a factory. That pattern
has shipped value separately (we used it just now to drive the
decisions captured under `docs/decisions/`); making it minifac-native
removes the dependency on a specific conversational tool.

## What to do

Read first:

- `docs/concepts/Brief.md` — the brief concept
- `docs/decisions/0004-Factory-vs-Input-Separation.md` — why briefs are
  separate
- `docs/decisions/0005-Brief-Schema.md` — the schema this helper must
  produce
- `examples/sample-brief.md` — the canonical template the helper should
  populate
- `docs/Roadmap.md` — context for where this sits
- Existing `.claude/` skill conventions in the repo (if any) — match
  the style of skills already shipped here

Then implement what the decisions and Roadmap describe. Concretely:

### 1. Claude Code skill at `.claude/skills/brief-authoring/`

- Standard Claude Code skill structure (`SKILL.md` + any supporting
  files). Activation: when the user invokes `/brief <name>` (or the
  conventional path for this repo's slash commands) OR asks Claude
  Code to "write a brief for X."
- The skill's behavior is **one question at a time**. It does NOT
  produce the brief all at once from a long prompt. It walks the
  user through:
  1. The change name (if not already given)
  2. The factory to target (default to `sdd`; let the user override)
  3. Background — what problem this addresses and why now
  4. What to do — concrete scope, including spec capability changes if
     known
  5. Out of scope — what to defer
  6. Acceptance criteria — how "done" is judged
  7. Any optional frontmatter (`base_branch`, `model`)
- Each question is focused and singular; the skill asks, waits for
  the user's response, and adapts the next question to what was just
  said. It does NOT batch questions or ask everything upfront.
- The skill consults the canonical specs and decision notes when it
  needs to recommend scope or flag obvious omissions ("you mentioned
  changing the runner — that's the `graph-runner` capability; want me
  to note that?").
- When the conversation is complete, the skill writes the brief to
  `inputs/<change>.md` using the schema from
  `docs/decisions/0005-Brief-Schema.md` and the template structure
  from `examples/sample-brief.md`. The frontmatter is exactly the
  fields the user resolved; the body uses the recommended sections.
- The user can stop at any time; the skill saves a partial brief
  and tells the user it's incomplete.

### 2. CLI verb `minifac brief <name>`

- New `brief` subcommand on the `minifac` CLI.
- Two modes:
  - **Interactive (default):** drops into a TTY-based one-question-at-
    a-time flow, ideally the same script the Claude Code skill uses.
    For now, prompts via `readline` or similar; the interaction is
    simpler than the skill's (no Claude in the loop), so it asks the
    same questions in series and concatenates the answers into a
    template.
  - **Non-interactive (`--from <file>`):** read answers from a YAML
    or JSON file matching the question schema; useful for scripting.
- Output: writes `inputs/<name>.md` in `cwd` (or `--out <path>` to
  override).
- The CLI verb does NOT need to be as smart as the Claude Code skill —
  it's a fallback for users who don't have Claude Code available, or
  for scripted brief generation. It just needs to produce a valid
  brief conforming to the schema.

### 3. Shared schema for the questions

- Define the question/answer schema in one place (probably under
  `src/brief/`) so both the Claude Code skill (via instructions in
  `SKILL.md`) and the CLI verb agree on what to ask.
- Skill consults the schema to know what to ask; CLI verb iterates
  the schema to prompt.

### 4. Tests

- Unit tests for the CLI verb's interactive flow (drive it via a
  scripted stdin or by exposing a programmatic API the test can
  call).
- A snapshot test on the produced brief shape — given a fixed set of
  answers, the output `inputs/<name>.md` matches an expected file.
- Tests that the produced brief is **valid** per the brief loader
  (`src/brief/loader.ts`) — round-trip: write the brief, then load
  it, assert fields parse cleanly.

### 5. Documentation

- Update `docs/concepts/Brief.md` to mention the new helper.
- Update `examples/sdd.md` (or wherever briefs are taught) to point at
  the helper.
- Add a short section to `README.md` showing the two ways to author a
  brief (Claude Code skill, CLI verb).

### Spec impact

- NEW capability `brief-authoring` (or fold into an existing one if
  there's a natural home) covering the question schema, the file
  output convention, and the validity guarantee.
- The CLI verb additions touch `run-cli` — MODIFIED requirement, or
  ADDED if it's a clean separate concern.
- `node-executor`, `graph-runner`, `factory-schema` are NOT affected.

Use your judgment on the exact spec breakdown.

## Out of scope

- **Auto-running the factory after authoring** — `minifac brief X`
  produces the brief and exits; the user runs `minifac run X`
  separately. Composing the two is a future ergonomic improvement,
  not this change.
- **Multi-line / rich-text editing in the CLI verb** — simple
  line-based prompts are enough; for complex briefs, the user can
  edit the file post-creation.
- **Brief dependencies, priority, or other future frontmatter fields**
  not in `docs/decisions/0005-Brief-Schema.md`. The helper produces
  the v0 schema only.
- **AI-driven generation in the CLI verb** — no Claude API calls
  from the CLI verb itself. The Claude Code skill is the AI-assisted
  path; the CLI verb is the offline / scripted path.
- **Templating beyond the recommended sections** — the helper offers
  the canonical structure; user can edit the file post-creation if
  they want different sections.

## Acceptance criteria

- `.claude/skills/brief-authoring/SKILL.md` exists with the
  one-question-at-a-time instructions
- `minifac brief <name>` runs and produces a valid brief file
- `minifac brief <name> --from answers.yaml` works with a scripted
  input
- Round-trip test: a brief produced by `minifac brief` loads cleanly
  through `loadBrief`
- All existing tests pass; new tests cover the brief-authoring flow
- `docs/concepts/Brief.md` and `README.md` updated
