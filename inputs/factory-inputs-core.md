---
change: factory-inputs-core
factory: sdd
base_branch: main
---

Binding decisions for this change live at:
- `docs/decisions/0004-Factory-vs-Input-Separation.md` — the
  factory-vs-input architectural framing
- `docs/decisions/0005-Brief-Schema.md` — required and optional
  frontmatter fields, permissive-on-extras
- `docs/decisions/0006-Verb-Shape.md` — `minifac run <thing>` with
  lookup precedence; drop direct factory-YAML invocation

Read those first. Also read `docs/concepts/Brief.md`,
`docs/concepts/Factory.md`, `docs/concepts/Runner.md`, and the
existing canonical specs at `openspec/specs/` (especially
`factory-schema/spec.md`, `graph-runner/spec.md`,
`run-cli/spec.md`, `sdd-factory/spec.md`).

This is the **keystone** of phase 1. Implement what those
decisions describe. Concretely:

### 1. Brief schema and loader

- New `Brief` schema (zod). Frontmatter: `change` (required,
  string), `factory` (required, string), `base_branch` (optional,
  string), `model` (optional, string). Loader is **strict on
  required fields, permissive on unknown extras**
  (`.passthrough()` or equivalent — future fields like
  `depends_on` must parse through without error).
- Body is markdown text. Loader returns frontmatter + body as a
  typed object.
- File location convention: `inputs/<change>.md` (relative to
  cwd / target repo root). The loader resolves both absolute
  paths and bare names (see verb shape below).

### 2. Factory consumes brief — runtime templating

- The factory's propose node prompt needs a slot for the brief
  body. Pick a simple templating mechanism — string interpolation
  of `{{ brief.body }}`, `${brief.body}`-style, or a small custom
  token. Document it; snapshot-test it.
- The runner builds the final prompt by substituting brief fields
  into the factory's prompt template before sending to the
  executor.
- Templated fields available: at minimum `{{ brief.change }}`,
  `{{ brief.body }}`. Optional: `{{ brief.factory }}`,
  `{{ brief.base_branch }}`, `{{ brief.model }}`.
- If a factory's prompt has no template tokens, runtime
  substitution is a no-op (backwards compatible with existing
  factory definitions).

### 3. Verb shape

- `minifac run <thing>` with auto-detect lookup precedence:
  1. If `<thing>` is a path (contains `/` or ends `.md`) → treat
     as brief path
  2. Else, try `inputs/<thing>.md` → if it exists, treat as
     brief by name
  3. Else, resolve `<thing>` against the available factories
     (per-repo `.minifac/factories/<thing>.yaml` first, then
     built-in `minifac:<thing>`; for this change, just check the
     existing factory loader path resolution and also accept a
     bare name resolving to `examples/<thing>.yaml` as a v0
     stopgap until phase 3 ships factory-composition)
  4. Else, error
- **Drop direct factory-YAML invocation.** `minifac run
  examples/sdd.yaml` (the path-to-factory pattern) is no longer
  supported. Briefs are the only way to invoke a factory for
  brief-driven workflows.
- The CLI's exit codes are unchanged.

### 4. Brief-less factory support

- Factory definitions declare `brief: "required" | "optional" |
  "none"` at the top level, default `"required"`.
- For `brief: "none"` factories, the verb's lookup precedence
  step 3 (resolve as factory name) succeeds without a brief.
- For `brief: "required"` invoked without a brief, the loader
  errors clearly.
- This is wired in but no built-in brief-less factory ships in
  this change (the SDD factory stays `brief: "required"`).

### 5. SDD factory migrated

- `examples/sdd.yaml` is restructured to consume a brief. The
  propose node's prompt template gains a `{{ brief.body }}` slot
  where the per-change intent is substituted in. The other three
  nodes (apply / verify / archive) reference
  `{{ brief.change }}` instead of hardcoded `<CHANGE_NAME>`.
- `examples/sdd.yaml` declares `brief: "required"`.
- `examples/sdd.md` updated to document the new brief-driven
  workflow.
- The structural test for `examples/sdd.yaml` updated to assert
  the new shape.
- Add a sample brief at `examples/sample-brief.md` demonstrating
  the schema (frontmatter + body), referenced from
  `examples/sdd.md`.

### Spec impact

Several canonical specs will need MODIFIED or ADDED requirements.
Likely:
- `factory-schema`: ADD requirement(s) for the `brief:` top-level
  field on factory definitions; if templating tokens are reserved
  in prompts, document that too.
- `run-cli`: MODIFIED requirement for the run subcommand's arg
  shape (brief path / brief name / factory name lookup
  precedence); REMOVED requirement for direct factory-YAML
  invocation.
- `sdd-factory`: MODIFIED requirements reflecting the brief-driven
  shape — the change name is no longer baked in; prompts template
  from the brief.
- NEW capability `brief-schema` (or similar) covering the brief
  frontmatter + body shape, strict-on-required
  permissive-on-extras, and where briefs live.

Use your judgment on the exact spec breakdown. Read the existing
specs carefully and choose MODIFIED vs ADDED appropriately. When
MODIFYING, copy the entire requirement block; do not partial-paste.

## Hard out of scope

- **Worktree management** — `minifac run` does NOT auto-create
  worktrees in this change (that's `worktree-mode`, phase 2). The
  user is still responsible for invoking from the right cwd /
  branch. Document this.
- **Brief authoring helper** — no Claude Code skill, no
  `minifac brief` verb. Briefs are hand-authored (or
  conversationally with whatever tool the user picks). That's
  `brief-authoring`, phase 2.
- **Factory composition** — no `.minifac/factories/`, no
  `extends:`, no `minifac:<name>` namespacing. That's
  `factory-composition`, phase 3.
- **Persistent run history** — no SQLite. That's
  `run-history-persistence`, phase 3.

Do not pull anything from phase 2 or 3 forward.
