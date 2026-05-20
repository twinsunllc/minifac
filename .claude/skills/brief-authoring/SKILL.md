---
name: brief-authoring
description: Co-author a minifac brief one question at a time. Use when the user runs `/brief <name>` or asks to "write a brief for X", "author a brief for Y", or "help me draft a brief". Walks the user through the canonical question schema (change, factory, background, what to do, out of scope, acceptance criteria, optional frontmatter), adapts follow-ups to their answers, and writes the result to `inputs/<change>.md` so `minifac run <change>` can consume it.
license: MIT
compatibility: Requires the minifac CLI and the brief-authoring capability shipped in this repo.
metadata:
  author: minifac
  version: "1.0"
---

Co-author a minifac brief one question at a time.

The output is a file at `inputs/<change>.md` that conforms to the
`brief-schema` capability — required `change` and `factory`
frontmatter fields, plus a free-form markdown body whose sections
(`Background`, `What to do`, `Out of scope`, `Acceptance criteria`)
mirror `examples/sample-brief.md`. The CLI verb `minifac brief` does
the same job offline; this skill is the AI-assisted version.

When the brief file exists, hand off to the user with: "Run
`minifac run <change>` to kick off the factory."

---

**Input**: The argument after `/brief` is the change name
(kebab-case) OR a description of what the user wants to build.

**Steps**

0. **Load the question schema**

   Read `src/brief/authoring.ts` and treat the exported
   `AUTHORING_QUESTIONS` list as the authoritative ordered question
   list. Also read `examples/sample-brief.md` as the canonical
   template the produced file should resemble.

   The schema's question order is:

   1. `change` (frontmatter, required)
   2. `factory` (frontmatter, required; default `sdd`)
   3. `background` (body, required)
   4. `what_to_do` (body, required)
   5. `out_of_scope` (body, optional)
   6. `acceptance_criteria` (body, required)
   7. `base_branch` (frontmatter, optional)
   8. `model` (frontmatter, optional)

1. **Resolve the change name**

   If `/brief <name>` was invoked, use `<name>` directly. Otherwise
   use the **AskUserQuestion tool** (open-ended) to ask what the
   user wants to build, and derive a kebab-case name from their
   answer (e.g. "add user auth" → `add-user-auth`).

2. **Confirm the factory**

   Default to `sdd`. Only ask via **AskUserQuestion** if the user's
   step-1 description suggested a different factory (e.g. a
   custom factory in their repo).

   The `factory:` value accepts two forms:
   - `<name>` — resolves against `.minifac/factories/<name>.yaml`
     first (the repo's custom or extended factory), then falls back
     to a built-in `examples/<name>.yaml`. Use this when the repo
     might have customizations and you want them applied.
   - `minifac:<name>` — always the built-in, ignoring any local
     `.minifac/factories/<name>.yaml`. Use this only when a specific
     brief needs the canonical factory regardless of repo
     customization.

3. **Ask Background**

   AskUserQuestion: "What problem does this change address, and why
   now?" Capture the answer for the body's `## Background` section.

4. **Ask What to do**

   AskUserQuestion: "What should the factory accomplish? Bullets or
   prose are fine." Capture for `## What to do`.

5. **Ask Out of scope** (optional)

   AskUserQuestion: "Anything the factory should NOT pull forward?
   (Skip if nothing comes to mind.)" Capture for `## Out of scope`,
   or omit the section if the user signals "nothing".

6. **Ask Acceptance criteria**

   AskUserQuestion: "How is 'done' judged for this change? Tests,
   specs, behaviors?" Capture for `## Acceptance criteria`.

   After any of steps 3–6, if the user names a capability or
   spec by name (e.g. "the run-cli spec", "the brief-schema
   capability"), you MAY consult
   `openspec/specs/<capability>/spec.md` for context and surface a
   short "you mentioned X — that's the `<capability>` capability;
   want me to note that in scope?" follow-up. This is a heuristic,
   not a hard step — skip when irrelevant.

7. **Optional frontmatter** (skippable)

   If the user has signaled "no overrides," skip this step entirely.
   Otherwise, **AskUserQuestion** for `base_branch` and `model`
   individually, defaults blank.

8. **Write the brief**

   Resolve the output path to `inputs/<change>.md` relative to the
   repo root. If that file already exists, AskUserQuestion whether
   to overwrite — never overwrite silently.

   Use the Write tool to create the file with the following shape
   (matching what `renderBrief` in `src/brief/authoring.ts` would
   produce for the same answers):

   ```markdown
   ---
   change: <change>
   factory: <factory>
   [base_branch: <if supplied>]
   [model: <if supplied>]
   ---

   ## Background

   <background answer>

   ## What to do

   <what_to_do answer>

   [## Out of scope

   <out_of_scope answer>]

   ## Acceptance criteria

   <acceptance_criteria answer>
   ```

   Frontmatter values that contain `:` or `#` SHALL be wrapped in
   double quotes (with internal `"` and `\` escaped). Omit
   optional lines entirely when the user did not supply them.

**Stop behavior**

At any point the user may say "stop", "pause", "we're done", or
similar. When they do:

- If you have NOT yet collected both `change` and `factory`,
  do not write a file. Reply with a one-line note that the
  brief lacks the minimum required frontmatter and exit.
- Otherwise, write a partial brief with whatever sections the
  user did provide, prepending the following blockquote to the
  body so future readers know it is incomplete:

  ```markdown
  > **Note:** Brief is incomplete; the authoring helper exited
  > before the `<next-question-id>` question.
  ```

  where `<next-question-id>` is the id of the next required
  question that wasn't answered. The frontmatter still satisfies
  `brief-schema` (the marker is body-only), so the partial brief
  loads cleanly through `minifac run`.

**Output**

After writing, print:

- The absolute path of the brief file you wrote.
- A one-line prompt: "Run `minifac run <change>` to kick off the
  factory."

If the brief is partial, also name the next unanswered question
so the user knows what to add by hand.

**Guardrails**

- Do not invent frontmatter fields beyond the schema (`change`,
  `factory`, `base_branch`, `model`, `mode`). Future fields are
  out of scope.
- Do not skip required questions. If the user gives a non-answer,
  re-ask once with a clarifying prompt; if they still decline,
  treat it as a stop signal.
- Refuse to overwrite an existing `inputs/<change>.md` without
  explicit user confirmation.
- One question at a time. Do not bundle multiple questions in a
  single AskUserQuestion.
- The Output section is your only chance to tell the user where
  the file went; print the absolute path verbatim.
