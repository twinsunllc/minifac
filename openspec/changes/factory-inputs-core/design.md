## Context

Decisions 0004 / 0005 / 0006 specify *what* to do; this document pins
*how* to do it inside the current codebase without growing premature
subsystems.

Current state:

- `src/factory/{schema,loader}.ts` defines `FactorySchema` (strict zod
  object) and `loadFactory` (file → parsed `LoadedFactory`).
- `src/runner/run.ts` walks the graph, builds a `RunContext` per node,
  dispatches to the executor, accumulates run-wide history.
- `src/executor/claude.ts` consumes the node's `with.prompt` string and
  the run history; it knows nothing about briefs.
- `src/cli.ts` exposes `minifac run <factoryPath>` and `minifac serve`.
- `examples/sdd.yaml` is hand-edited per change (`<CHANGE_NAME>` and
  `cwd` find-and-replace).

Constraints from `CLAUDE.md`:

- No premature subsystems. Brief loader is one new directory next to
  `factory/`, not a package.
- No anthropomorphic metaphors. Naming follows behavior:
  `brief-schema`, `Brief`, `loadBrief`, `substituteBriefTokens`.
- Snake_case YAML, strict schema with permissive extras documented at
  load time.
- No new runtime dependencies. Frontmatter parsing reuses the existing
  `yaml` package; no `gray-matter` or similar.
- TypeScript strict mode; tests next to code.

## Goals / Non-Goals

**Goals:**

- Briefs are first-class inputs with a strict-on-required,
  permissive-on-extras frontmatter schema, parsed by a single loader
  that returns a typed object.
- `minifac run <thing>` resolves what to run via the lookup precedence
  in decision 0006, with no separate verbs and no flags.
- Factories declare their relationship to briefs via a top-level
  `brief: required | optional | none` field.
- The runner substitutes `{{ brief.<field> }}` tokens in node prompts
  immediately before dispatch, leaving prompts without tokens untouched.
- The shipped SDD factory is migrated to the brief-driven shape and
  serves as the documented example.
- All existing tests stay green; new tests cover the new surface.

**Non-Goals:**

- No worktree creation, no branching, no per-run filesystem isolation.
  The user invokes `minifac run` from the right cwd.
- No `minifac brief` verb, no Claude Code skill, no authoring helper.
  Briefs are hand-authored.
- No `.minifac/factories/` directory, no `extends:`, no
  `minifac:<name>` built-in namespacing. The v0 factory-name lookup is
  just `examples/<name>.yaml` as a stopgap.
- No SQLite, no run-history persistence beyond what already exists.
- No changes to the serve daemon's HTTP API. Briefs over HTTP is a
  later phase.
- No changes to the executor interface or `with.prompt` semantics
  beyond the runner's pre-dispatch substitution.
- No reserved tokens beyond `{{ brief.* }}`. `{{ env.* }}`, `{{ cwd }}`,
  etc. are out of scope.

## Decisions

### Decision: Brief frontmatter parsed with `yaml`, body is the remainder

The brief file is split at the first occurrence of `---` opening fence
(line 1) and the next `---` closing fence. Everything between is parsed
with the existing `yaml` package's `parseDocument` (same path the
factory loader uses, so error locations are consistent). Everything
after the closing fence is the body string, trimmed of one leading
newline.

A file with no frontmatter fence is a load error ("brief is missing
required frontmatter"). A file with frontmatter but no body is valid
(the body string is empty).

**Why not `gray-matter` or a dedicated frontmatter package:** one
dependency we don't take. The split rule is six lines of code, the YAML
parse path is already wired.

### Decision: Brief schema strict on required, permissive on extras via `.passthrough()`

```ts
const BriefFrontmatterSchema = z
  .object({
    change: z.string().min(1),
    factory: z.string().min(1),
    base_branch: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .passthrough();
```

- Required-field absence → load error naming the missing field.
- Known-field type mismatch → load error naming the offending field
  and its actual type.
- Unknown extras (e.g. `depends_on: [foo]`, `priority: high`) → parse
  through without error. They appear on the parsed object as
  `unknown`-typed properties. The runner ignores them in v0; future
  changes that consume them must add explicit fields.

**Why not `.catchall(z.unknown())`:** `passthrough` is the idiomatic
zod knob for "keep unknown keys verbatim." `catchall` types every
unknown key uniformly, which is a stronger statement than we want.

### Decision: Reserved tokens are `{{ brief.<field> }}`, substituted by the runner

Token shape: literal `{{`, optional whitespace, `brief.`, an identifier
matching `[a-zA-Z_][a-zA-Z0-9_]*`, optional whitespace, literal `}}`.
Regex: `/\{\{\s*brief\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g`.

Substitution rules:

- The runner walks each scheduled node's `with.prompt` string (if a
  string; non-string `prompt` is left untouched — the executor will
  validate).
- For each match, look up the field on the resolved brief:
  - `change`, `body`, `factory`: always present on a resolved brief;
    substitute the string value.
  - `base_branch`, `model`: optional on the brief; substitute the
    string value if present, otherwise substitute the empty string.
  - Any other identifier: leave the token verbatim in the prompt (the
    executor sees `{{ brief.foo }}` literally). This is forward-compat
    for new fields without an error-on-typo gotcha — the model will
    see and report the literal token, which is a clearer signal than a
    silent empty.
- When the run has no brief (brief-less factory), substitution is a
  no-op: tokens stay verbatim. The factory author opted into
  `brief: "none"`; the prompt must therefore not depend on
  substitution.

**Why `{{ brief.field }}` and not `${brief.field}`:** Mustache-style
double-brace is unambiguous in YAML (no escape needed); the `${...}`
form collides with shell-variable conventions and template-literal
syntax. The decisions don't pin a syntax; we pick Mustache for
familiarity.

**Why string-level substitution and not a real templating engine:** the
substitution surface is tiny (five field names), and a real engine
imports complexity (conditionals, loops, escaping rules) we don't need.
The regex is six characters of cyclomatic complexity.

### Decision: Substitution lives in the runner, between scheduling and dispatch

The current `runFactory` (`src/runner/run.ts`) builds a per-node
`RunContext` and hands the node + ctx to the executor. The new step
goes immediately before that handoff: if a `brief` was supplied to
`runFactory`, the runner rewrites the node's `with.prompt` (if a
string) by token substitution, then dispatches the rewritten node.

**Why in the runner, not the executor:** the executor doesn't know
about briefs. Pushing brief-awareness into the executor would mean
every future executor (`shell`, `codex`) has to re-implement
substitution. Keeping it in the runner means one substitution path for
every executor.

**Why not at load time:** the factory loader produces a *factory
definition*, not a run-specialized instance. Two `minifac run`s of the
same factory with different briefs need different effective prompts;
substitution must happen per-run.

`runFactory`'s signature grows one optional argument: `brief?: Brief`.
When omitted (brief-less factory or test fixtures), substitution is
skipped entirely.

### Decision: Factory `brief:` field is a top-level enum with default `"required"`

```ts
const FactorySchema = z.object({
  // ...existing fields...
  brief: z.enum(["required", "optional", "none"]).optional(),
  // ...
}).strict();
```

A factory that omits `brief:` is interpreted as `"required"`. The
default is "the common case" — most factories (the SDD loop, future
brief-driven workflows) need a brief; nightly drift checks and
similar are the exception.

**Why default to `"required"` rather than `"optional"`:** decision
0006 says the loader errors clearly when a `brief: required` factory
is invoked without a brief. Defaulting to `"required"` means a factory
authored without thinking about briefs gets the safer error, not the
quieter "runs with no brief, tokens stay literal" path.

**Why three states and not two:** `"optional"` lets a single factory
serve both modes (e.g. nightly drift runs without a brief; a triaged
drift run with a brief that names the focus area). Today we ship no
`"optional"` factory; the value exists so the schema doesn't need a
migration when one arrives.

### Decision: CLI lookup precedence is auto-detect on a single positional

The new `minifac run <thing>` resolves `<thing>` in this order:

1. **Path-like** — `thing` contains `path.sep` (or `/`), or ends in
   `.md`. Treat as brief path. Resolve relative paths against the CLI's
   cwd; absolute paths used as-is. If the file does not exist, exit 1
   with "brief not found at <path>".
2. **Brief by name** — `inputs/<thing>.md` exists relative to the CLI's
   cwd. Treat as brief by name.
3. **Factory by name** — `examples/<thing>.yaml` exists relative to the
   CLI's cwd. Treat as brief-less factory invocation. The factory's
   declared `brief:` mode controls whether brief-less is legal.
4. **Else** — write "could not resolve `<thing>` as a brief path,
   brief name, or factory name" to stderr and exit 1.

Direct factory-YAML invocation by path is removed. A user who supplies
a `.yaml` path on the CLI is misusing the verb; we don't try to
salvage it (the error in step 4 tells them what the CLI accepts).

**Why bake `examples/` in for v0 instead of looking up
`.minifac/factories/<name>.yaml`:** factory composition is phase 3;
shipping `.minifac/` lookup now would mean we'd later have to evolve a
contract that only `examples/` repos exercised. `examples/` is what
the shipped factories live under today, and it's documented in
`examples/sdd.md`. The directory name is a stopgap; phase 3 replaces
it.

### Decision: Brief→factory resolution reuses the same factory-name lookup

When a brief is loaded, its `factory:` field is a name (e.g. `sdd`).
The CLI resolves that name with the same logic as step 3 of the verb
precedence — try `examples/<name>.yaml`. No path-based brief.factory
values in v0.

A brief whose `factory:` field cannot be resolved is a usage error
(exit 1, name the missing factory).

### Decision: A `brief: required` factory invoked without a brief fails before any node runs

The CLI builds the run plan (resolve brief, resolve factory, resolve
mode) before invoking `runFactory`. If a `brief: required` factory is
invoked at step 3 of the lookup precedence (brief-less), the CLI exits
1 with "factory `<name>` requires a brief; invoke as `minifac run
<brief-name>` instead." No partial run starts.

Conversely, `brief: none` invoked *with* a brief is also rejected — the
factory said it doesn't consume briefs; running it with one is a user
error. Exit 1, name the conflict.

`brief: optional` accepts either mode without complaint.

### Decision: `examples/sdd.yaml` migrates; `examples/hello.yaml` becomes `brief: "none"`

`sdd.yaml`:

- Top-level `brief: "required"`.
- Every `<CHANGE_NAME>` substring in every node's prompt becomes
  `{{ brief.change }}`.
- `propose`'s prompt gains a `## Intent for this change` section
  containing `{{ brief.body }}` — that's the slot the brief's body
  drops into.
- Per-node `cwd: /path/to/target/repo` placeholders are retained as
  today (cwd-from-brief is a separate concern, deferred to phase 2's
  worktree work).

`hello.yaml`:

- Add top-level `brief: "none"`.
- Prompt unchanged. `minifac run hello` continues to work end-to-end
  and now exercises the brief-less code path.

`examples/sample-brief.md` (new):

```markdown
---
change: example-change
factory: sdd
---

## Background

A one-paragraph statement of what the change addresses and why it
matters right now.

## What to do

A bulleted or prose description of the intended work, scoped to what
the factory should accomplish. The propose node embeds this section
(and everything else in the body) verbatim into its prompt.

## Out of scope

What the factory should not pull forward.

## Acceptance criteria

How "done" is judged for this change.
```

The sample is referenced from `examples/sdd.md` as the recommended
template; the loader does not enforce the section headings.

### Decision: `inputs/factory-inputs-core.md` ships as the dogfooded brief

The very brief that drives this factory through its own SDD loop ships
under `inputs/factory-inputs-core.md`. That file contains:

- frontmatter `change: factory-inputs-core`, `factory: sdd`
- body = the intent block from this proposal's parent task prompt
  (which the runner currently injects via the
  `sdd-factory-inputs.yaml` workaround at the repo root)

Shipping the brief in-tree closes the loop: future iterations of this
factory on this factory can be invoked as `minifac run
factory-inputs-core` once the verb shape lands.

The `sdd-factory-inputs.yaml` file at the repo root, which currently
inlines the intent block as a long YAML prompt, is removed by this
change — its content moves into the brief, and invocation goes through
the new verb.

### Decision: Don't change the executor's stream-json payload shape

The runner substitutes tokens in `with.prompt` *before* handing the
node to the executor. From the executor's perspective, the prompt is a
fully-resolved string with no tokens. The executor's existing
`buildStreamJsonInput` (and the sentinel-injection logic on top of it)
sees the substituted string and operates as today.

This keeps the runner-executor seam clean: substitution is the
runner's responsibility; the executor never sees a token. It also
means the existing executor snapshot tests stay green — they pin the
post-substitution payload shape, not the pre-substitution template.

## Risks / Trade-offs

- **[Token-syntax pick is permanent-ish]** → Mitigation: the syntax is
  documented in `factory-schema` spec text and in the wire-format
  comment block of the runner. Changing it later is a coordinated
  rewrite. We pick `{{ brief.field }}` because it's the most common
  templating dialect and reads naturally inside YAML strings.
- **[Permissive-on-extras hides typos]** → Mitigation: known fields
  are validated strictly (type + presence); only *unknown* keys pass
  through. A typo on `change` → load error. A typo on `bsae_branch`
  (instead of `base_branch`) → silently ignored. Acceptable trade-off
  for forward-compat. The brief-authoring helper (phase 2) can lint
  for known-but-misspelled keys.
- **[Lookup precedence ambiguity]** → Mitigation: the precedence is
  deterministic and documented (path → brief-by-name → factory-by-name
  → error). The path check is `thing.includes(path.sep) ||
  thing.endsWith(".md")`, which is unambiguous. Users who want to
  force one path can: prefix with `./` to force path semantics; pass
  the bare name to use name semantics.
- **[Direct factory-YAML invocation removal breaks muscle memory]**
  → Mitigation: `examples/sdd.md` carries a prominent migration note;
  the lookup error in step 4 lists what the CLI now accepts. The
  shipped tests are updated to use the new verb shape.
- **[Tokenless prompts in brief-required factories silently get no
  per-change content]** → Mitigation: not a code-side concern (the
  prompt is the factory author's contract). Documented in
  `examples/sdd.md`. A future linter could warn if a
  `brief: required` factory has no `{{ brief.* }}` tokens, but that's
  not in scope for v0.
- **[Test surface grows]** → Mitigation: each new piece (brief loader,
  template substitution, lookup precedence) lives next to its code in
  `*.test.ts`. The existing test layout absorbs them without a new
  framework.
- **[`inputs/` directory convention is implicit cwd-relative]** →
  Mitigation: this is by design (decision 0006). The cwd-relative
  resolution is consistent with how the factory loader resolves paths
  today. Worktree mode (phase 2) revisits cwd semantics.
- **[`hello.yaml` declares `brief: "none"` to keep `minifac run
  hello` working — does that ship a "built-in brief-less factory"
  contrary to the task brief?]** → No. The proposal's "no built-in
  brief-less factory" sentence refers to factories under a
  `minifac:<name>` namespace (phase 3). `examples/hello.yaml` is the
  pre-existing smoke-test factory; marking it `brief: "none"` is a
  one-line backwards-compat fix so the documented `minifac run hello`
  smoke test still passes after the verb-shape change. Not a new
  feature surface.

## Migration Plan

No production data. Migration is one repo's worth of files:

1. Land the schema and loader changes (brief loader; factory `brief:`
   field; runner substitution; CLI lookup precedence) with their tests.
2. Migrate `examples/sdd.yaml` and `examples/hello.yaml` in the same
   commit set as the schema changes (the structural tests are coupled).
3. Add `examples/sample-brief.md` and the dogfooded
   `inputs/factory-inputs-core.md`. Remove the temporary
   `sdd-factory-inputs.yaml` at the repo root.
4. Rewrite `examples/sdd.md` around the brief-driven workflow. Add a
   migration note for anyone with a pre-change copy of `sdd.yaml`
   ("replace `<CHANGE_NAME>` with `{{ brief.change }}`; add `brief:
   required`; author a brief at `inputs/<name>.md`").
5. Update `README.md`'s "Run the example" section to invoke `minifac
   run hello` (no brief required) and `minifac run <change-name>` (for
   the SDD loop) rather than `minifac run hello.yaml`.

Anyone with a copy of pre-change `sdd.yaml` (i.e. a `sdd-<name>.yaml`
file authored before this change) has three options:

1. Convert the file: rename `<CHANGE_NAME>` → `{{ brief.change }}`
   throughout, add `brief: required` to the top, and author the brief.
2. Continue using the old shape with an older `minifac` binary. The
   binary is unversioned in v0; this is a documentation-only escape
   hatch.
3. Inline the intent body into the brief and discard the per-change
   YAML entirely. This is the intended end state.

## Open Questions

- **Token whitespace tolerance.** The regex tolerates whitespace inside
  the braces (`{{ brief.foo }}` and `{{brief.foo}}` both match). Should
  it also tolerate `{{brief . foo}}` (whitespace around the dot)?
  Going with **no** for v0 — the dot is part of the identifier path,
  not a binary operator. Reconsider if a real templating syntax lands.
- **Brief resolution when `factory:` is missing from frontmatter but a
  `--factory` flag is supplied to the CLI.** No such flag in v0. Out
  of scope. The brief's `factory:` field is the single source of
  truth.
- **What happens when a brief loads but its declared `factory:` resolves
  to a `brief: "none"` factory?** Decision: rejected at run-plan time
  with "factory `<name>` does not accept a brief; invoke as `minifac
  run <name>` directly." Same shape as the inverse rejection above.
- **Should the loader normalize `change` to kebab-case?** No — the
  loader validates that `change` is a non-empty string and leaves
  normalization to the brief author. Decision 0005 says kebab-case is
  the convention, not the contract.
