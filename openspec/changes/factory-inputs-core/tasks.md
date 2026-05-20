## 1. Brief schema and loader

- [x] 1.1 Create `src/brief/schema.ts`. Export
      `BriefFrontmatterSchema = z.object({ change, factory, base_branch?,
      model? }).passthrough()` and an inferred `BriefFrontmatter` type.
      Use `z.string().min(1)` for the required fields and the optional
      ones (rejects empty strings).
- [x] 1.2 Create `src/brief/loader.ts`. Export `Brief` (the typed
      object: `{ frontmatter: BriefFrontmatter; body: string;
      sourcePath: string }`), `BriefLoadError` (mirrors
      `FactoryLoadError`'s shape: message, sourcePath, optional
      `{line, col}`), and `loadBrief(pathOrName: string, cwd?:
      string): Promise<Brief>`.
- [x] 1.3 Implement `loadBrief`:
      (a) Resolve the input: if it contains `path.sep` or ends in
          `.md`, treat as path (relative-to-cwd or absolute); else
          treat as bare name and resolve to
          `path.join(cwd, "inputs", name + ".md")`.
      (b) Read the file; throw `BriefLoadError` on ENOENT naming the
          resolved path.
      (c) Split the file: require line 1 to be `---`; find the next
          `---` line on its own; reject (with a clear `BriefLoadError`)
          on missing opening or closing fence. Frontmatter is the
          lines between; body is everything after the closing fence
          with one optional leading newline stripped.
      (d) Parse frontmatter with `parseDocument` from `yaml`; surface
          YAML errors as `BriefLoadError` with `{line, col}` taken
          from `linePos` (mirror `loadFactory` exactly).
      (e) Validate with `BriefFrontmatterSchema.parse`; on ZodError,
          emit a `BriefLoadError` whose message names the offending
          dotted path and validation detail (mirror `loadFactory`'s
          ZodError handling).
      (f) Return `{ frontmatter, body, sourcePath: absolute }`.
- [x] 1.4 Add `src/brief/loader.test.ts` covering:
      - Happy path: frontmatter + body parses; sourcePath is absolute
      - Bare-name input resolves to `<cwd>/inputs/<name>.md`
      - Path input (`./foo.md`) is used verbatim
      - Missing required field (`factory`) → `BriefLoadError` with the
        field name in the message
      - Wrong-type known field (`change: 42`) → `BriefLoadError` naming
        the field
      - Optional fields parse when present
      - Unknown extras pass through and appear on the returned object
      - Missing file → `BriefLoadError` naming the resolved path
      - Missing opening fence → `BriefLoadError` naming the missing
        frontmatter
      - Missing closing fence → `BriefLoadError` naming the
        unterminated frontmatter
      - Empty body is valid; `body === ""`
      - YAML syntax error in frontmatter reports line/col

## 2. Factory schema: top-level `brief:` field

- [x] 2.1 In `src/factory/schema.ts`, extend `FactorySchema` with
      `brief: z.enum(["required", "optional", "none"]).optional()`.
      The schema remains `.strict()`. Add a post-parse default in
      `loadFactory` (or in the schema via `.transform`/`.default`) so
      a loaded factory always has `brief` resolved to a literal —
      preferred path: `.default("required")` on the field so the
      typed `Factory.brief` is non-optional `"required" | "optional" |
      "none"`.
- [x] 2.2 Update `src/factory/loader.test.ts` (or add new cases) to
      cover:
      - Factory without `brief:` field defaults to `"required"`
      - Explicit `brief: optional` parses
      - Explicit `brief: none` parses
      - `brief: yolo` is rejected with a schema error naming the
        offending value
      - Unknown top-level key (e.g. `briefs: required`) is still
        rejected as today (strict-on-extras unchanged)

## 3. Runner: brief token substitution

- [x] 3.1 In `src/runner/run.ts`, extend `runFactory`'s options to
      accept an optional `brief?: Brief`. Thread it through to the
      per-node dispatch site without altering the existing
      executor-interface contract.
- [x] 3.2 Add `src/runner/substitute.ts` (small focused file)
      exporting `substituteBriefTokens(prompt: string, brief: Brief):
      string`. Regex:
      `/\{\{\s*brief\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g`. Field
      resolution:
      - `change` / `body` / `factory`: substitute the string value
        from `brief.frontmatter` (or `brief.body` for `body`).
      - `base_branch` / `model`: substitute the string value if
        present, else `""`.
      - Anything else: return the matched token verbatim (preserve
        the original substring).
- [x] 3.3 In the per-node dispatch path, immediately before calling
      the executor, compute the effective node:
      - If `brief` is provided AND the node's `with.prompt` is a
        string, rewrite the `with` object with the substituted prompt.
        Otherwise pass the node through unchanged.
      - Do not mutate the original factory's node objects; build a
        shallow-cloned node + `with` for dispatch. (Important: the
        runner's loop re-uses the factory across iterations.)
- [x] 3.4 Add `src/runner/substitute.test.ts`:
      - Single token substitution (`{{ brief.change }}`)
      - Body substitution preserves newlines / markdown verbatim
      - Missing optional field substitutes `""`
      - Unknown identifier passes through verbatim
      - Tokenless prompt is byte-identical to input (no copy if
        no match, but observable correctness is what's tested)
      - Whitespace tolerance inside braces (`{{brief.change}}` works
        too)
      - Multiple tokens in one prompt all substitute
- [x] 3.5 Extend `src/runner/run.test.ts` (or add a new test file) to
      verify that when `runFactory` is called with a brief, the
      executor receives `with.prompt` already substituted (use the
      fake executor harness already in those tests to assert against
      the received node).
- [x] 3.6 Confirm: when `runFactory` is called with no brief and a
      prompt that contains `{{ brief.change }}`, the executor sees the
      token verbatim. Add a test case.

## 4. CLI: lookup precedence and brief-mode enforcement

- [x] 4.1 Add `src/cli/resolve.ts` (or co-locate in `src/cli.ts`)
      exporting a `resolveRunArg(arg: string, cwd: string):
      Promise<ResolvedRun>` where `ResolvedRun` is a discriminated
      union: `{ kind: "brief", brief: Brief, factoryPath: string }`
      or `{ kind: "factory", factoryPath: string }`. Implement the
      precedence:
      1. `arg.includes(path.sep)` or `arg.endsWith(".md")` → brief
         path. Throw a clear error if the file doesn't exist.
      2. Else if `inputs/<arg>.md` exists in cwd → brief by name.
      3. Else if `examples/<arg>.yaml` exists in cwd → factory by
         name.
      4. Else throw a `RunArgResolutionError` with a message naming
         the tried inputs.
      In cases 1 and 2, load the brief, then resolve its `factory:`
      field as `examples/<factory>.yaml` and throw if missing.
- [x] 4.2 In `src/cli.ts`, replace the existing `run` subcommand
      action with a flow that:
      (a) calls `resolveRunArg`,
      (b) calls `loadFactory(factoryPath)`,
      (c) reads `factory.brief` and enforces:
          - `required` + no brief → exit 1 with a message naming the
            factory and that a brief is required;
          - `none` + brief → exit 1 with a message naming the
            factory and the conflict;
          - `optional` + either → proceed;
      (d) calls `runFactory(loaded, { registry, brief, onEvent })`
          with the brief threaded through.
- [x] 4.3 Update the existing run-argument description in the
      `commander` config from "path to a factory YAML file" to
      something like "brief path, brief name, or factory name".
- [x] 4.4 Update `src/cli.test.ts` to:
      - Replace the existing `minifac run hello.yaml` test with
        `minifac run hello` (and update the test fixture / cwd to
        ensure `examples/hello.yaml` is resolvable).
      - Add tests for: brief-by-path runs; brief-by-name runs;
        factory-by-name runs (brief-less); brief takes precedence
        over a same-named factory.
      - Add tests for the new error cases: brief-required + no brief;
        brief-none + brief; missing thing; brief's factory missing.
      - Confirm exit codes are unchanged (success = 0; usage / load
        errors = 1; node failures = 2; budget exhausted = 3).

## 5. Migrate `examples/sdd.yaml`

- [x] 5.1 Add top-level `brief: required` to `examples/sdd.yaml`.
- [x] 5.2 Replace every `<CHANGE_NAME>` substring in every node's
      `prompt` with `{{ brief.change }}`. There are no other
      placeholders.
- [x] 5.3 In `propose.with.prompt`, add an `## Intent for this change`
      section whose body is the single line `{{ brief.body }}` (no
      surrounding prose; the brief body is the prose). Confirm the
      surrounding propose criteria (openspec validate, required
      artifacts on disk) are preserved.
- [x] 5.4 Confirm `cwd` placeholders on each node remain as today;
      cwd-from-brief is a phase-2 worktree concern.

## 6. Migrate `examples/hello.yaml`

- [x] 6.1 Add top-level `brief: none` to `examples/hello.yaml`. Prompt
      unchanged. This keeps `minifac run hello` working under the new
      lookup precedence as the brief-less smoke-test path.

## 7. Ship the sample brief and dogfooded brief

- [x] 7.1 Create `examples/sample-brief.md` with the canonical brief
      template (frontmatter `change`, `factory: sdd`, and a body with
      recommended sections: Background, What to do, Out of scope,
      Acceptance criteria). The loader does not enforce section
      headings.
- [x] 7.2 Create `inputs/factory-inputs-core.md` containing the brief
      that drives this very change. Frontmatter: `change:
      factory-inputs-core`, `factory: sdd`, `base_branch: main`. Body:
      the intent block currently inlined in `sdd-factory-inputs.yaml`
      at the repo root.
- [x] 7.3 Delete `sdd-factory-inputs.yaml` at the repo root. Its
      content now lives in `inputs/factory-inputs-core.md` plus the
      shipped `examples/sdd.yaml`. Confirm the file isn't referenced
      by any spec or test.

## 8. Update `examples/sdd.md`

- [x] 8.1 Rewrite the "How to use it" section around the brief-driven
      workflow: author a brief at `inputs/<change>.md`, invoke
      `minifac run <change>`. Reference `examples/sample-brief.md` as
      the shape to author against.
- [x] 8.2 Drop the "Migration note" entries that describe the
      pre-this-change copy-and-edit workflow (per
      `sdd-factory-uses-claude-controls` and the archive-commits
      change) — those migrations no longer apply to copies because
      copies are no longer the workflow. Replace them with a single
      "Migration from pre-`factory-inputs-core` copies" note that
      tells holders of pre-change `sdd-<name>.yaml` files to:
      (a) rename `<CHANGE_NAME>` → `{{ brief.change }}`,
      (b) add `brief: required` to the top of the file (or, easier,
          delete their copy and use the shipped `examples/sdd.yaml`
          instead),
      (c) author a brief at `inputs/<name>.md`,
      (d) invoke `minifac run <name>`.
- [x] 8.3 Update the "Per-node contract" subsection bullets so each
      node's prompt-language reference uses `{{ brief.change }}`
      instead of `<CHANGE_NAME>`. Per-node responsibility prose
      otherwise unchanged.
- [x] 8.4 Update the "Fields users edit when copying" subsection: it
      becomes "Fields the brief supplies." Drop the find-and-replace
      recipe; describe how `change` (from frontmatter) and the brief
      `body` end up in the prompt via runtime substitution.
- [x] 8.5 Add a short "Template tokens" subsection listing the five
      reserved `{{ brief.<field> }}` tokens (`change | body | factory
      | base_branch | model`) and noting that unknown identifiers
      pass through verbatim.

## 9. Update `README.md`

- [x] 9.1 Update the "Run the example" section to invoke `minifac run
      hello` (brief-less) and `minifac run <change>` (brief-driven)
      instead of `minifac run hello.yaml` / `minifac run
      examples/sdd.yaml`.
- [x] 9.2 Add a short paragraph describing the brief-driven workflow
      and pointing at `examples/sample-brief.md` and `examples/sdd.md`.

## 10. Update structural test for the SDD factory

- [x] 10.1 In `src/factory/sdd-example.test.ts`:
      - Add an assertion that `factory.brief === "required"`.
      - Add an assertion that `propose.with.prompt` contains
        `{{ brief.change }}` AND `{{ brief.body }}`.
      - Add an assertion that for each of `apply`, `verify`,
        `archive`, the prompt contains `{{ brief.change }}`.
      - Add an assertion that NO node's prompt contains the substring
        `<CHANGE_NAME>` (the old placeholder).
      - Keep the existing per-node criteria assertions
        (`openspec validate`, `tasks.md`, `verify`, `openspec
        archive`, `git commit`) — the brief-driven shape preserves
        the per-node criteria prose. Adjust them only if the prompt
        edit drops a keyword (it should not).
      - Keep the existing `permission_mode`, terminal-node,
        start-node, edge-budget, and topology assertions unchanged.

## 11. Verify

- [x] 11.1 Run `npm run check` and `npm run build`. Both SHALL exit 0.
- [x] 11.2 Run `npm test`. All existing tests SHALL pass; all new
      tests added under tasks 1.4, 2.2, 3.4–3.6, 4.4, and 10.1 SHALL
      pass.
- [x] 11.3 Run `npx openspec validate factory-inputs-core --strict`
      and confirm clean exit. Iterate on spec deltas until it does.
- [x] 11.4 Manual spot-check (not automated): with the new CLI shape,
      invoke `npx tsx src/cli.ts run hello` against the migrated
      `examples/hello.yaml` and confirm streaming output appears and
      exit code is 0. (This is a smoke-test; full claude-driven
      end-to-end is a human concern outside this change's apply
      phase.)
