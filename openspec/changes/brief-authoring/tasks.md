## 1. Shared question schema and renderer

- [x] 1.1 Create `src/brief/authoring.ts`. Export:
      - `AuthoringQuestionId` — union literal of the eight ids
        (`change | factory | background | what_to_do | out_of_scope |
        acceptance_criteria | base_branch | model`).
      - `AuthoringQuestion` — typed record with `id`, `prompt`,
        `required`, `applies` (`"frontmatter" | "body-section"`),
        optional `default`, optional `frontmatterKey`, optional
        `bodyHeading`.
      - `AUTHORING_QUESTIONS` — readonly array of `AuthoringQuestion`,
        in the canonical order pinned by the spec
        (`change → factory → background → what_to_do → out_of_scope
        → acceptance_criteria → base_branch → model`), with the
        required/optional flags from the spec table.
      - `AuthoringAnswers` — `Partial<Record<AuthoringQuestionId,
        string>>`.
- [x] 1.2 In the same file, export `renderBrief(answers:
      AuthoringAnswers): string`. Implementation:
      - Assemble frontmatter as `---\n<lines>\n---\n` where each
        line is `<key>: <value>` for the four frontmatter
        questions (`change`, `factory`, `base_branch`, `model`) in
        canonical order, skipping any with an empty/missing value.
      - YAML-encode values minimally: if the value is a "safe"
        string (`/^[A-Za-z0-9._\/-]+$/`), emit unquoted; otherwise
        wrap in double quotes and escape internal `"` and `\`.
      - Assemble the body: for each body-section question in
        canonical order, if the answer is non-empty, emit a blank
        line, the heading (`## <heading>`), a blank line, and the
        answer text. Skip optional sections with empty/missing
        answers. End the body with a single trailing newline.
      - Output is deterministic and matches the snapshot test.
- [x] 1.3 Export a small helper `partialBriefPrefix(nextId:
      AuthoringQuestionId): string` that returns the markdown
      blockquote block named in the spec (the partial-brief marker).
      `renderBrief` accepts an optional second argument `{
      incompleteAt?: AuthoringQuestionId }` and, when supplied,
      prepends the partial-brief marker to the body (between the
      closing frontmatter fence and the first body section).
- [x] 1.4 Create `src/brief/authoring.test.ts`. Cover:
      - Schema enumerates the eight ids in canonical order with the
        spec's required flags.
      - `renderBrief` snapshot for the canonical full-answer
        fixture (all eight questions answered).
      - `renderBrief` snapshot for required-only answers (no
        `out_of_scope` / `base_branch` / `model`).
      - `renderBrief` is deterministic: two calls with the same
        input produce byte-identical output.
      - `renderBrief` with `incompleteAt: "background"` includes the
        partial-brief marker naming `background` at the top of the
        body.
      - Round-trip: write `renderBrief(...)` to a tmp file and
        assert `loadBrief` returns a `Brief` with the expected
        frontmatter fields and a body containing the expected
        section headings.
      - YAML quoting: a value containing `:` or `#` is rendered
        quoted and round-trips through `loadBrief` to the original
        string.

## 2. CLI subcommand: `minifac brief`

- [x] 2.1 Create `src/cli/brief.ts`. Export:
      - `BriefCommandIO` interface = `{ stdin: NodeJS.ReadableStream
        & { isTTY?: boolean }; stdout: NodeJS.WritableStream;
        stderr: NodeJS.WritableStream }`.
      - `briefCommandAction(opts: { name: string; from?: string;
        out?: string; force?: boolean; cwd: string; io:
        BriefCommandIO }): Promise<number>` — returns the desired
        exit code.
- [x] 2.2 Implement the output-path resolver:
      - `outPath = opts.out ?? path.join(opts.cwd, "inputs",
        `${opts.name}.md`)`.
      - If the resolved file exists and `--force` is not supplied,
        write a stderr usage error and return `1`.
- [x] 2.3 Implement `--from <file>` mode:
      - Detect extension; reject anything other than `.yaml`,
        `.yml`, `.json` with a usage error listing the supported
        extensions.
      - Parse the file (`yaml.parse` for YAML; `JSON.parse` for
        JSON).
      - Validate via a zod schema (`AuthoringAnswersSchema =
        z.object({ change: z.string(), factory: z.string(),
        background: z.string(), what_to_do: z.string(),
        acceptance_criteria: z.string(),
        out_of_scope: z.string().optional(),
        base_branch: z.string().optional(),
        model: z.string().optional() }).strict()`).
      - On a `ZodError`, surface the first issue: missing required
        → "missing required answer `<id>`"; unknown key → "unknown
        answer `<id>`; supported: change | factory | ..."; wrong
        type → "answer `<id>` must be a string".
      - On success, call `renderBrief`, write the file, then call
        `loadBrief(outPath, opts.cwd)`; on failure of `loadBrief`,
        emit the error and return `1`. On success, print `outPath`
        to stdout on its own line and return `0`.
- [x] 2.4 Implement interactive mode (default):
      - If `--from` not supplied and `opts.io.stdin.isTTY !== true`,
        emit "interactive mode requires a TTY; use --from <file>"
        to stderr and return `1`.
      - Build a readline interface over the injected
        `stdin` / `stdout`. Track answers in
        `Record<AuthoringQuestionId, string>`. Track a `stopped`
        boolean and a `stoppedAt` question id.
      - For each question in `AUTHORING_QUESTIONS`, in order:
        - Write `prompt + "\n"` to stdout, with a `(required)` or
          `(optional, blank to skip)` hint.
        - Read one line. On `null` (EOF), set
          `stopped = true; stoppedAt = question.id` and break.
        - On the sentinel `:q`, same as EOF.
        - On empty line for a required question, write
          `"(required)\n"` and re-prompt the same question.
        - On empty line for an optional question, treat as omitted
          and continue.
        - For `change`, if the answer is empty and a positional
          `name` was supplied, use `name` as the default and
          continue (the CLI pre-fills the question).
        - For `factory`, if the answer is empty and the question
          has a default (`sdd`), use the default.
        - Otherwise record the answer and advance.
      - Wire `SIGINT` to set `stopped = true; stoppedAt = current
        question.id` and resolve the loop. (Use a try/finally to
        clean up listeners.)
- [x] 2.5 Handle interactive end states:
      - If `stopped` and `answers.change` or `answers.factory` is
        empty, emit "brief is missing required frontmatter
        (change / factory)" to stderr and return `1` without
        writing.
      - If `stopped` (with required frontmatter present) or the
        loop completed:
        - Compute `incompleteAt`: the first required question id
          whose answer is missing, if any.
        - Call `renderBrief(answers, { incompleteAt })`.
        - Write the file, then call `loadBrief(outPath, opts.cwd)`;
          on failure, surface and return `1`.
        - Print `outPath` to stdout on its own line.
        - If `incompleteAt` is set, emit a stderr line "(brief is
          incomplete; next question was `<incompleteAt>`)".
        - Return `0`.
- [x] 2.6 In `src/cli.ts`, register the new subcommand:
      - `program.command("brief").description(...).argument("<name>",
        ...).option("--from <file>", ...).option("--out <path>",
        ...).option("--force", ...).action(...)`.
      - The action constructs `BriefCommandIO` from `io.stdin ??
        process.stdin`, `io.stdout`, `io.stderr` and calls
        `briefCommandAction`, then sets the closure-level
        `exitCode` to its return value.
      - Extend the `CliIO` interface with optional `stdin?:
        NodeJS.ReadableStream & { isTTY?: boolean }`. The
        production entrypoint at the bottom of `cli.ts` passes
        `process.stdin`.
- [x] 2.7 Create `src/cli/brief.test.ts`. Cover:
      - `--from` happy path: a YAML fixture with all required
        answers produces a brief whose contents equal
        `renderBrief(answers)` (snapshot), the file loads via
        `loadBrief`, exit code 0.
      - `--from` happy path with `.json` extension.
      - `--from` missing required → exit 1, error names the id.
      - `--from` unknown key → exit 1, error names the id.
      - `--from` wrong-type value → exit 1, error names the id.
      - `--from` unsupported extension (`.toml`) → exit 1, error
        names the supported extensions.
      - `--out` overrides destination.
      - Existing destination without `--force` → exit 1, original
        file unchanged.
      - `--force` overwrites.
      - Interactive happy path: drive `stdin` with a `PassThrough`
        feeding canned newline-delimited answers, assert the
        resulting file matches the snapshot and exits 0.
      - Interactive stop after frontmatter: feed `change`,
        `factory`, then EOF; assert the written file contains the
        partial-brief marker naming `background`, exit code 0,
        stderr names `background`.
      - Interactive stop before required frontmatter: feed EOF
        immediately; assert no file is written and exit code is
        non-zero.
      - Non-TTY without `--from`: invoke with `stdin.isTTY = false`
        and no `--from`; assert exit 1 and the suggestion message.

## 3. Claude Code skill and slash command

- [x] 3.1 Create `.claude/skills/brief-authoring/SKILL.md`. Mirror
      the frontmatter shape of
      `.claude/skills/openspec-propose/SKILL.md` (`name`,
      `description`, `license`, `compatibility`, `metadata`).
      `description` SHALL be written so Claude Code activates the
      skill on `/brief <name>` and on natural-language requests
      like "write a brief for X" / "help me author a brief for Y".
- [x] 3.2 In the skill body, write numbered steps:
      - **Step 0** — Read the shared schema at
        `src/brief/authoring.ts` and the canonical template at
        `examples/sample-brief.md`. Treat the exported
        `AUTHORING_QUESTIONS` list as the source of truth for what
        to ask and in what order.
      - **Step 1** — Resolve the change name. Use the positional
        if `/brief <name>` was invoked; otherwise AskUserQuestion
        for a description and derive a kebab-case name.
      - **Step 2** — Confirm the factory. Default to `sdd`; ask
        once via AskUserQuestion only if the user said something
        ambiguous in step 1.
      - **Steps 3–6** — One AskUserQuestion per body-section
        question (`background`, `what_to_do`, `out_of_scope`,
        `acceptance_criteria`), in that order. After each answer,
        the skill MAY scan `openspec/specs/<capability>/spec.md`
        files for any capability the user named, and surface a
        follow-up like "you mentioned X — that's the <capability>
        capability; want me to note that?".
      - **Step 7** — Optional frontmatter (`base_branch`,
        `model`). The skill MAY skip these entirely if the user
        signals "no overrides."
      - **Step 8** — Use the Write tool to produce the brief file
        at `inputs/<change>.md`. The file's frontmatter and body
        shape SHALL match what `renderBrief` would produce for the
        same answers. If `inputs/<change>.md` already exists, the
        skill asks the user before overwriting.
      - **Stop behavior** — at any point the user may say
        "stop" / "pause" / "we're done"; the skill writes a
        partial brief (with the same incomplete-marker block the
        CLI uses) and exits with a one-line summary naming the
        next unanswered question.
- [x] 3.3 Add an **Output** section to `SKILL.md` describing what
      the skill prints after writing: the absolute path of the
      written file and a one-line "Run `minifac run <change>` to
      kick off the factory" prompt.
- [x] 3.4 Add a **Guardrails** section to `SKILL.md` mirroring
      `openspec-propose`'s style: do not invent fields beyond the
      schema; do not skip required questions; refuse to overwrite
      an existing brief without explicit user confirmation.
- [x] 3.5 Create `.claude/commands/brief.md` as a one-liner that
      points Claude Code at the skill, mirroring
      `.claude/commands/opsx/propose.md`'s pattern.

## 4. Documentation updates

- [x] 4.1 Update `docs/concepts/Brief.md`'s "Authoring" section:
      replace the existing one-paragraph mention of "a Claude Code
      skill or similar" with a short list naming the two surfaces
      (`/brief <name>` in Claude Code, `minifac brief <name>` from
      the terminal) and pointing at `examples/sample-brief.md`.
- [x] 4.2 Update `examples/sdd.md`'s "How to use it" section:
      add a one-paragraph "Authoring the brief" lead-in that
      recommends `minifac brief <change>` (or `/brief <change>` in
      Claude Code) as the starting point, then continues with the
      existing flow.
- [x] 4.3 Update `README.md`'s "Run the example" section: under
      the SDD-loop paragraph, add a short note that briefs can be
      authored interactively via `minifac brief <change>` or the
      `/brief <change>` Claude Code slash command, in addition to
      hand-editing `inputs/<change>.md` in any editor.

## 5. Verify

- [x] 5.1 Run `npm run check` and `npm run build`. Both SHALL
      exit 0.
- [x] 5.2 Run `npm test`. All existing tests SHALL pass; the new
      tests added under tasks 1.4 and 2.7 SHALL pass.
- [x] 5.3 Run `npx openspec validate brief-authoring --strict`
      and confirm clean exit. Iterate on spec deltas until it
      does.
- [x] 5.4 Smoke-test the CLI: from the repo root, run
      `node dist/cli.js brief smoke-test --from
      tests/fixtures/smoke-answers.yaml --out /tmp/smoke.md` (or
      the equivalent invocation with a hand-built fixture) and
      confirm that `/tmp/smoke.md` loads cleanly via `loadBrief`
      (a quick `node -e ...` is fine — this is a smoke test, not
      an automated case).
