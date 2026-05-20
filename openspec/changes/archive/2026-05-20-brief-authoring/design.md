## Context

The brief is the per-change input that drives the SDD factory and any
future brief-driven factory. Today briefs are hand-edited. We have two
existing references for "interactive workflow tooling" in this repo:

- `.claude/skills/openspec-propose/SKILL.md` is the closest analogue
  for the Claude Code skill side — it documents the surface, lists
  steps, and is invoked via the `/opsx:propose` slash command at
  `.claude/commands/opsx/propose.md`.
- `src/cli.ts` is a single-file `commander` program with three
  subcommands (`run`, `prune`, `serve`). The `brief` subcommand
  slots in as a fourth.

The schema and loader for briefs are already pinned by the
`brief-schema` capability. Authoring sits *upstream* of the loader:
it produces a file that the loader then accepts.

Constraints from `CLAUDE.md`:

- No premature subsystems. The authoring code lives under
  `src/brief/` and `src/cli/`, not a new package.
- Snake_case YAML, kebab-case file names, tests next to code.
- No anthropomorphic metaphors. The helper is a "brief-authoring
  flow," not a "wizard" or "interviewer."
- No new runtime dependencies if avoidable.
- The point of the project is dogfooding; the helper must produce
  files that load cleanly through the existing loader, with a test
  that proves it.

## Goals / Non-Goals

**Goals:**

- One **shared question schema** that both surfaces consume. Adding,
  reordering, or relabeling a question is a single-file edit. The
  Claude Code skill references the schema file by relative path so
  the surfaces don't drift.
- A Claude Code skill (`brief-authoring`) that walks the user
  one-question-at-a-time, adapts the next question to the previous
  answer, consults canonical specs / decision notes when the user
  references a capability by name, and writes
  `inputs/<change>.md`.
- A CLI verb (`minifac brief <name>`) with interactive and
  `--from <file>` modes that produces the same brief shape, without
  invoking Claude.
- Round-trip validity: the file the helper writes loads cleanly
  through `loadBrief`. The CLI verb asserts this at write time; the
  test suite asserts it via a snapshot test plus a real
  `loadBrief` call against the produced file.
- The user can stop the flow at any point and keep what they have
  (CLI: ^C / EOF; skill: user says "stop" or similar). Partial
  briefs are saved with a marker — a top-of-body
  `> **Note:** Brief is incomplete; the authoring helper exited
  before <next-question-id>.` block — and are still parseable by
  `loadBrief` (frontmatter validity is what the loader cares about;
  the body is free-form).

**Non-Goals:**

- No new frontmatter fields. The helper only produces fields already
  declared by `brief-schema` (`change`, `factory`, `base_branch`,
  `model`, `mode`). Future fields (`depends_on`, `priority`, etc.)
  are out of scope.
- No "compose the factory automatically." After the brief is
  written, the user runs `minifac run <change>` themselves.
- No multi-line / rich-text editing in the interactive CLI mode.
  Single-line answers per prompt; for longer body sections, the
  user types a one-line summary in the CLI flow and edits the file
  afterward.
- No AI/LLM calls from the CLI verb. The Claude Code skill is the
  AI-assisted path; the verb is the offline / scripted fallback.
- No `--update` mode (re-author an existing brief). The verb writes
  a fresh brief; editing an existing one is a manual concern. The
  verb refuses to overwrite an existing file unless `--force` is
  passed.
- No daemon / serve integration. Brief authoring is a CLI / skill
  concern; the daemon stays focused on runs.

## Decisions

### Decision: Shared question schema lives in `src/brief/authoring.ts`

The schema is a typed list of `AuthoringQuestion` records:

```ts
export interface AuthoringQuestion {
  id: AuthoringQuestionId;
  prompt: string;                          // the human-facing prompt
  required: boolean;                       // CLI re-asks; skill insists
  default?: string;                        // applied if user answers ""
  applies: "frontmatter" | "body-section"; // where the answer lands
  // when applies === "frontmatter":
  frontmatterKey?: "change" | "factory" | "base_branch" | "model" | "mode";
  // when applies === "body-section":
  bodyHeading?: string;                    // markdown H2 heading
}

export type AuthoringQuestionId =
  | "change"
  | "factory"
  | "background"
  | "what_to_do"
  | "out_of_scope"
  | "acceptance_criteria"
  | "base_branch"
  | "model";

export const AUTHORING_QUESTIONS: readonly AuthoringQuestion[];
```

Same file exports a pure render function:

```ts
export function renderBrief(answers: AuthoringAnswers): string;
```

where `AuthoringAnswers` is `Partial<Record<AuthoringQuestionId, string>>`.
`renderBrief` assembles the frontmatter YAML and the body markdown
in a deterministic order matching `examples/sample-brief.md`. It
emits only the fields the user actually answered (no empty
`base_branch:` lines). For `change` it falls back to a passed-in
override (the CLI passes the `<name>` arg as the default for the
`change` question).

**Why a typed list, not a `Record<id, Question>`:** the question
order *is* the schema. A list preserves ordering at the type level;
a record requires a separate "order" array that could drift.

**Why `applies` discrimination instead of two separate lists:** the
CLI loop renders prompts in one pass; splitting them by where the
answer lands would mean two loops with no semantic benefit. The
discriminator keeps it one loop.

### Decision: CLI `brief` subcommand is one file, registered in `src/cli.ts`

`src/cli/brief.ts` exports a `briefCommandAction(io, opts)` that:

1. Resolves the change name: positional `<name>` arg is the
   default for the `change` question. If `--out` is supplied, that
   path is used; otherwise the output path is
   `path.join(cwd, "inputs", name + ".md")`.
2. Refuses to overwrite an existing output file unless `--force`
   is supplied; writes a usage error to stderr and exits 1 in that
   case.
3. In **`--from <file>` mode**: reads and parses the file (YAML
   or JSON, detected by extension), validates the answers against
   the question schema (every required question must be answered
   to be considered complete; missing optional answers are fine),
   renders the brief via `renderBrief`, writes it, then loads the
   written file via `loadBrief` and exits 0. A schema error on
   `--from` input exits 1 with a clear message; a `loadBrief`
   failure on the written file is a bug and exits 1 with the
   error message.
4. In **interactive mode** (the default): opens
   `readline.createInterface({ input, output })` over the I/O
   handles, walks `AUTHORING_QUESTIONS` in order, asks each
   prompt, and reads one line back. If the user enters an empty
   line for a required question, the CLI re-asks with a short
   "(required)" hint. If the user enters an empty line for an
   optional question, the default (if any) or omission applies.
   If the user sends EOF / ^C / types `:q` or `:stop`, the loop
   exits early; the CLI renders what it has, prepends the
   "incomplete" marker, writes the file, and exits 0 with a
   stderr line naming the next question that wasn't asked.
5. On successful write (complete or partial), the CLI prints the
   absolute path of the written brief to stdout on its own line
   and exits 0.

`src/cli.ts` adds the subcommand:

```ts
program
  .command("brief")
  .description("Author a brief at inputs/<name>.md via one-question-at-a-time prompts.")
  .argument("<name>", "change name (used as default for the `change` frontmatter field)")
  .option("--from <file>", "Non-interactive: read answers from a YAML or JSON file")
  .option("--out <path>", "Override the default output path (inputs/<name>.md)")
  .option("--force", "Overwrite an existing brief file")
  .action(async (name: string, opts: { from?: string; out?: string; force?: boolean }) => { ... });
```

The `CliIO` interface (already defined in `src/cli.ts`) is extended
with optional `stdin?: NodeJS.ReadableStream` so tests can drive
the readline flow with a scripted stream. In production the default
is `process.stdin`.

**Why register in the existing `src/cli.ts` and not a new
`src/cli/index.ts`:** `src/cli.ts` is already the one CLI file. The
other action handlers (`run`, `prune`, `serve`) live inline; the
`brief` action is delegated to `src/cli/brief.ts` because its
interactive logic is substantial and the test surface is its own
concern. The cli.ts wiring is six lines.

### Decision: Claude Code skill at `.claude/skills/brief-authoring/SKILL.md`, slash command at `.claude/commands/brief.md`

`SKILL.md` mirrors `openspec-propose/SKILL.md`'s shape (frontmatter
with `name`, `description`, version metadata; numbered steps).
Behavior:

- **Step 0** — read the shared question schema at
  `src/brief/authoring.ts` and the canonical template at
  `examples/sample-brief.md`. The skill uses the schema as the
  authoritative ordered question list.
- **Step 1** — resolve the change name. If the user invoked
  `/brief <name>`, use that; else AskUserQuestion for the change
  name. Derive kebab-case if the user gave a description.
- **Step 2** — confirm the factory (default `sdd`; let the user
  override). One question via AskUserQuestion.
- **Steps 3–6** — walk Background, What to do, Out of scope,
  Acceptance criteria one at a time via AskUserQuestion. After each
  answer, the skill MAY consult the canonical specs under
  `openspec/specs/<capability>/spec.md` if the answer mentions a
  capability by name, and surface that as a "you mentioned <X>,
  that's the <capability> capability — want me to note that in
  scope?" follow-up. Otherwise it proceeds to the next question.
- **Step 7** — optional frontmatter (`base_branch`, `model`,
  `mode`). The skill MAY skip these if the user signals "no
  overrides needed."
- **Step 8** — write the brief to `inputs/<change>.md` using the
  Write tool. The skill SHALL produce a file whose frontmatter and
  body shape match what `renderBrief` would produce for the same
  answers (the test suite verifies this by snapshotting both).
- **Stop semantics** — at any point the user may say "stop" or
  similar; the skill writes a partial brief (with the same
  incomplete-marker line the CLI uses) and exits.

The slash command file at `.claude/commands/brief.md` is a one-line
shim that points Claude Code at the skill, mirroring the pattern in
`.claude/commands/opsx/propose.md`.

**Why a slash command + skill split:** `.claude/commands/` holds the
typed entry points; `.claude/skills/` holds the behavior. This is
the convention `openspec-propose` uses and is already familiar to
users of this repo.

**Why reference `src/brief/authoring.ts` from the skill instead of
embedding the question list in `SKILL.md`:** the schema is the
source of truth. Embedding it twice invites drift. The skill is
allowed to summarize or rephrase questions for the user (better
prompts than the bare CLI's), but the *list and order* come from
the schema file.

### Decision: Question order and the body section mapping

The eight questions in canonical order:

| id                    | applies      | maps to                                  |
|-----------------------|--------------|------------------------------------------|
| `change`              | frontmatter  | `change:`                                |
| `factory`             | frontmatter  | `factory:` (default `sdd`)               |
| `background`          | body-section | `## Background`                          |
| `what_to_do`          | body-section | `## What to do`                          |
| `out_of_scope`        | body-section | `## Out of scope`                        |
| `acceptance_criteria` | body-section | `## Acceptance criteria`                 |
| `base_branch`         | frontmatter  | `base_branch:` (optional, skip if blank) |
| `model`               | frontmatter  | `model:` (optional, skip if blank)       |

Required: `change`, `factory`, `background`, `what_to_do`,
`acceptance_criteria`. Optional: `out_of_scope`, `base_branch`,
`model`. (Out of scope is a body section the schema lists for
structure; an empty answer renders the heading with no body, or is
omitted — the CLI defaults to omitting.)

`mode` is intentionally **not** in v0's question list. The vast
majority of briefs run worktree-mode; users who need
`mode: in-place` add the line by hand. Adding it later is a
schema-edit only.

**Why this exact set:** these are the recommended body sections in
`examples/sample-brief.md` plus the four declared frontmatter
fields. Anything beyond is outside the v0 schema and would need a
schema-deltas change first.

### Decision: `--from <file>` answer file shape

The answer file is a YAML or JSON document whose top-level is an
object keyed by `AuthoringQuestionId`. Example:

```yaml
change: my-change
factory: sdd
background: |
  Multi-line markdown allowed.
what_to_do: |
  - bullet 1
  - bullet 2
acceptance_criteria: Tests pass; specs validate.
```

Validation rules:

- Unknown keys are rejected with a usage error naming the offending
  key and the list of valid ids.
- Required questions missing → rejected with a usage error naming
  the missing question id.
- Values must be strings; non-string values are rejected.

This shape mirrors `AuthoringAnswers` exactly; the CLI's `--from`
parser is one zod schema and one `parse` call.

**Why not accept arbitrary frontmatter keys / body markdown in the
answers file:** the answers file is *answers to questions*, not a
pre-baked brief. If a user has a pre-baked brief, they don't need
this verb. Keeping the answers file aligned to the question schema
lets us evolve both atomically.

### Decision: Partial-brief marker is in the body, not the frontmatter

When the user stops early, the CLI prepends to the body:

```markdown
> **Note:** Brief is incomplete; the authoring helper exited before
> the `<next-question-id>` question.
```

The frontmatter still satisfies `brief-schema` (required fields are
asked first, so if the user stopped before `change` or `factory`,
no file is written and the CLI exits 1 with "nothing to save"). The
marker is body-only so `loadBrief` accepts the file unchanged.

**Why a body marker, not a frontmatter `incomplete: true` field:**
`brief-schema` is permissive on extras, so we could add an
`incomplete:` key — but it would couple the authoring concern to the
load-time concern. Future code that wants to know "is this brief
incomplete?" can grep the body for the marker; the schema stays
unchanged.

### Decision: Skill activates on `/brief <name>` and on natural-language requests

The Claude Code activation surface is two paths:

1. **Slash command** — `.claude/commands/brief.md` documents the
   `/brief <name>` entry point and triggers the skill.
2. **Natural language** — `SKILL.md`'s `description` field is
   written so Claude Code surfaces it when the user says things
   like "write a brief for the X change" or "help me author a brief
   for Y." The description text doubles as the trigger heuristic.

**Why both:** the slash command is fast and unambiguous; natural
language is the lower-friction surface most users will use.
`openspec-propose` follows the same pattern.

### Decision: Round-trip validity is asserted at runtime AND in tests

The CLI verb, after writing the file, calls `loadBrief(outPath, cwd)`
and exits 1 if it throws. This catches any future bug in
`renderBrief` that produces a file the loader rejects.

The test suite covers the same invariant in two ways:

1. A snapshot test pins the exact bytes `renderBrief` produces for
   a fixed `AuthoringAnswers` input.
2. A round-trip test calls `renderBrief`, writes to a tmp file,
   and asserts `loadBrief` succeeds with the expected
   frontmatter and a non-empty body.

**Why both:** the snapshot catches accidental whitespace / heading
shifts. The round-trip test catches loader-rejection regressions
the snapshot wouldn't notice (e.g. if someone changes the brief
schema and the renderer drifts).

## Risks / Trade-offs

- **[Question list ossifies]** Once shipped, reordering or renaming
  questions changes the snapshot and the `--from` schema. → Mitigation:
  the schema is one file. Changes to the list go through a normal
  spec proposal; the only callers are the CLI loop and the skill,
  both of which iterate the schema dynamically. No external
  consumers.
- **[Interactive CLI is line-based; user can't write multi-line
  body sections]** → Mitigation: explicitly out of scope for v0.
  The CLI writes a single-line answer per body section and tells
  the user (in the final stdout line that names the written path)
  that they can edit the file before invoking `minifac run`. The
  Claude Code skill is the answer for users who want richer
  authoring.
- **[`--from` file format ambiguity (YAML vs JSON)]** →
  Mitigation: detect by extension (`.yaml` / `.yml` → YAML; `.json`
  → JSON; anything else → usage error naming the supported
  extensions). The parser is a single `if/else` and a `try/catch`.
- **[Partial brief marker is body-only, so a user who rewrites the
  body manually loses the "incomplete" signal]** → Mitigation:
  acceptable. Once the user is hand-editing the body they've taken
  ownership of completeness; the marker is a hint to the author,
  not a runtime guarantee. The runner doesn't care about the
  marker.
- **[Skill drifts from the CLI because Claude Code may rephrase
  questions]** → Mitigation: the skill is allowed to rephrase
  prompts (for better UX), but the *id list and order* come from
  the schema file. The skill is instructed to read that file. A
  test snapshots the output of `renderBrief` against an example
  set of answers; whatever the skill outputs must converge to the
  same file shape for the same answer content. We rely on the
  skill being instructed clearly; we cannot mechanically prevent
  drift in a Claude-driven flow.
- **[Conflict with existing `inputs/<name>.md`]** → Mitigation:
  refuse to overwrite without `--force`. The Claude Code skill
  should also check and ask before overwriting (added to
  `SKILL.md` step 8).
- **[`readline` interactive flow is hard to test deterministically]**
  → Mitigation: factor the interactive driver as a function that
  takes `(stdin, stdout, schema, opts) → Promise<AuthoringAnswers
  | "stopped">`. Tests drive it with `PassThrough` streams; the
  CLI wires `process.stdin` / `process.stdout` in production. The
  same pattern other Node CLIs use.
- **[CI environments without a TTY would hang the interactive
  flow]** → Mitigation: in CI, users invoke `--from`. The
  interactive mode requires a TTY by design; if `process.stdin` is
  not a TTY and `--from` was not supplied, the CLI exits 1 with a
  usage error suggesting `--from <file>`.

## Migration Plan

No production data; no breaking changes. Land in this order:

1. Ship `src/brief/authoring.ts` (schema + renderer) with its unit
   tests. No other files need to change.
2. Ship `src/cli/brief.ts` and wire the subcommand in `src/cli.ts`.
   Add tests. CLI-only release at this point is usable.
3. Ship `.claude/skills/brief-authoring/SKILL.md` and
   `.claude/commands/brief.md`. These are documentation-shaped
   files; no behavior change to the binary.
4. Update `docs/concepts/Brief.md`, `README.md`, and
   `examples/sdd.md` to reference the new surfaces.

Existing briefs (`inputs/factory-inputs-core.md`,
`inputs/worktree-mode.md`, the brief that drives this change at
`inputs/brief-authoring.md`) continue to load and run unchanged.
The new verb is purely additive.

## Open Questions

- **Should the interactive flow show the rendered brief and confirm
  before writing?** Going with **no** for v0 — the user can edit
  the file after the fact, and the file path is printed to stdout.
  Reconsider if user feedback finds the no-preview behavior
  surprising.
- **Should `--from` support stdin (`--from -`)?** Out of scope for
  v0. Add later if asked; the parser sees a string either way.
- **Should the Claude Code skill embed canonical-spec lookup as a
  hard step, or as a "may consult" hint?** Going with **may
  consult**. Hard-stepping every answer through spec lookup adds
  latency and noise for changes that aren't spec-touching. The
  skill's instructions list "consult specs when the user names a
  capability" as a heuristic; it's free to skip when irrelevant.
- **`mode: in-place`** is not in the v0 question list. If users
  ask for it, we add the question; it's a one-line schema edit.
