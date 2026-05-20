## Why

Today every per-change YAML in minifac is a hand-copied 150-line clone of
`examples/sdd.yaml` — ~90% factory boilerplate, ~10% change-specific
intent, glued together with find-and-replace on `<CHANGE_NAME>` and a
hard-coded `cwd`. The result couples the orchestrator (the factory) to
the per-change data, forces a conversational tool into the loop just to
copy YAML, and makes brief authoring ceremonial.

Decisions
[`0004-Factory-vs-Input-Separation`](../../../docs/decisions/0004-Factory-vs-Input-Separation.md),
[`0005-Brief-Schema`](../../../docs/decisions/0005-Brief-Schema.md), and
[`0006-Verb-Shape`](../../../docs/decisions/0006-Verb-Shape.md) accept the
split: factories stay infrastructure; **briefs** carry per-change data;
`minifac run <thing>` resolves the right thing by lookup precedence.

This is the keystone of phase 1 — every later phase (worktree mode,
brief-authoring helper, factory composition, run-history persistence)
assumes brief-as-input and the new verb shape are in place.

## What Changes

- **NEW** `Brief` schema + loader. YAML frontmatter (`change`, `factory`
  required; `base_branch`, `model` optional; **permissive on unknown
  extras**) plus a free-form markdown body. Loader is strict on
  required-field presence and known-field types.
- **NEW** runtime prompt templating. Before dispatching a node, the
  runner substitutes `{{ brief.<field> }}` tokens (where `<field>` is
  `change | body | factory | base_branch | model`) into the node's
  `with.prompt` string. Prompts without tokens are unchanged (backwards
  compatible).
- **NEW** factory top-level `brief:` field with literal values
  `"required" | "optional" | "none"`, default `"required"`. The CLI
  enforces the declared mode at invocation time.
- **NEW** verb shape — `minifac run <thing>` with auto-detect lookup
  precedence:
  1. path-like → brief path
  2. bare name with `inputs/<name>.md` present → brief by name
  3. bare name resolving to `examples/<name>.yaml` → factory by name
     (v0 stopgap until phase 3's factory-composition ships)
  4. else error
- **BREAKING** direct factory-YAML invocation (`minifac run
  examples/sdd.yaml`) is removed. Factories are addressed by name only;
  brief-driven workflows go through a brief.
- **MIGRATED** `examples/sdd.yaml` consumes a brief: `propose` gains a
  `{{ brief.body }}` slot for per-change intent; all four prompts
  reference `{{ brief.change }}` instead of `<CHANGE_NAME>`. The file
  declares `brief: "required"`.
- **MIGRATED** `examples/hello.yaml` declares `brief: "none"` so
  `minifac run hello` still works as the smoke-test path for the new
  verb shape (and demonstrates brief-less mode without shipping a new
  built-in factory).
- **NEW** `examples/sample-brief.md` demonstrating the brief schema,
  referenced from the rewritten `examples/sdd.md`.
- **DOCS** `examples/sdd.md` rewritten around the brief-driven
  workflow; the "copy the YAML, find-and-replace" recipe is replaced
  with "author a brief, run by name."

## Capabilities

### New Capabilities

- `brief-schema`: the per-change input format — frontmatter required and
  optional fields, permissive-on-extras loader, on-disk location
  convention (`inputs/<change>.md`), and the typed shape returned to the
  CLI.

### Modified Capabilities

- `factory-schema`: adds an optional top-level `brief:` field with
  literal-value validation, and reserves `{{ brief.* }}` template tokens
  in node prompt strings.
- `graph-runner`: adds the prompt-template substitution step in the
  per-node dispatch path (substitution happens between scheduling and
  the executor call).
- `run-cli`: the `run` subcommand's positional-argument shape changes
  from "factory YAML path" to "any of brief path / brief name / factory
  name" with auto-detect precedence; direct factory-YAML invocation is
  removed.
- `sdd-factory`: the shipped SDD factory becomes brief-driven —
  `brief: "required"`, `<CHANGE_NAME>` placeholders replaced by
  `{{ brief.change }}`, `propose` gains a `{{ brief.body }}` slot, and
  the "copy-and-edit the YAML per change" workflow is replaced by
  "author a brief, run by name."

## Impact

- `src/factory/schema.ts`, `src/factory/loader.ts`: add the top-level
  `brief:` field (default `"required"`) to `FactorySchema`.
- `src/brief/` (new): `schema.ts` + `loader.ts` for the brief format.
  Single new directory; no new package.
- `src/runner/run.ts`: a new pre-dispatch substitution step that takes
  the resolved brief (if any) and rewrites each node's `with.prompt`
  string with `{{ brief.* }}` tokens substituted. Tokenless prompts are
  untouched.
- `src/cli.ts`: replaces the existing `run <factory>` action with the
  lookup-precedence resolver. Exit codes unchanged.
- `examples/sdd.yaml`, `examples/sdd.md`, `examples/hello.yaml`: shipped
  examples migrate to the new shape.
- `examples/sample-brief.md` (new): demonstrates the schema.
- `inputs/factory-inputs-core.md` (new, this change): the brief that
  invokes this very factory, dogfooding the workflow.
- `src/factory/sdd-example.test.ts`: updated to assert the
  brief-driven shape (no more `<CHANGE_NAME>` placeholders; assert
  `brief: "required"` and the new template tokens).
- New tests under `src/brief/` and `src/runner/` cover the brief loader,
  the template substitution, and the CLI's lookup precedence.
- No new runtime dependencies. YAML frontmatter parsing reuses the
  existing `yaml` package.
- Removed: the "minifac run examples/sdd.yaml" path. Documented in the
  rewritten `examples/sdd.md` migration note.
- Out of scope (deferred to later phases): worktree management, the
  brief-authoring helper / Claude Code skill, `.minifac/factories/`
  composition, persistent run history. See
  [`docs/Roadmap.md`](../../../docs/Roadmap.md).
