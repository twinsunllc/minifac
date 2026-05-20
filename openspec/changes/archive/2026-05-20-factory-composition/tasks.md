## 1. Factory schema: `extends:` field

- [x] 1.1 Extend `FactorySchema` in `src/factory/schema.ts` to accept
      an optional top-level `extends: z.string().min(1).optional()`.
      Keep `.strict()` on the top-level object. Update the exported
      `Factory` type — the resolved factory (post-merge) SHALL NOT
      carry `extends:`, so model the type so that downstream code
      doesn't need to handle it.
      (Apply-phase note: introduced `FactoryLayerSchema` for the
      on-disk shape, which permits `extends:` and makes nodes/edges/
      name optional so derived layers can omit fields. The merged
      result validates through the existing `FactorySchema`, which
      remains strict-no-extras and rejects `extends:`. Downstream
      code keeps the same `Factory` type.)
- [x] 1.2 Reject `extends:` of an invalid shape (empty string,
      non-string types) with the existing Zod path/message format.

## 2. Factory loader: extends chain resolution

- [x] 2.1 Add a chain-resolver helper (either inside
      `src/factory/loader.ts` or in a new sibling
      `src/factory/extends.ts`). Signature roughly:
      `resolveExtendsChain(entryPath: string, callerCwd: string):
      Promise<Factory>`. It SHALL read the entry file, follow
      `extends:` references, and return the merged factory ready for
      post-schema validation.
      (Landed at `src/factory/extends.ts`. `FactoryLoadError` was
      extracted to `src/factory/loader-error.ts` so the resolver
      and loader can share it without a cycle.)
- [x] 2.2 Implement reference resolution:
      - `minifac:<name>` → `<callerCwd>/examples/<name>.yaml`
      - `<name>` (no prefix, no path separator) →
        `<callerCwd>/.minifac/factories/<name>.yaml`
      - Anything else (path separators, file extensions) →
        `FactoryLoadError` with a clear message.
- [x] 2.3 Detect cycles by tracking visited absolute paths during
      chain walk. Self-reference and longer cycles both throw
      `FactoryLoadError` naming the file sequence and the edge that
      closed the loop.
- [x] 2.4 Implement replace-at-node-level merge:
      - Nodes: per-id replace; ids not in derived layer are preserved
        from base; new ids are added.
      - Edges: if derived layer declares `edges:` (including `[]`),
        replace wholesale; if omitted, inherit base.
      - Top-level `name`, `description`, `brief`: overwrite if
        declared in derived layer; else inherit.
      - `extends:` is stripped from the resolved factory before
        returning.
- [x] 2.5 Modify `loadFactory(sourcePath)` to call the chain resolver
      with `callerCwd = process.cwd()` (or accept an optional
      `callerCwd` parameter for testability — pick one and document).
      Run the existing post-schema validation
      (`validatePostSchema`) against the resolved factory; the
      `sourcePath` on errors SHALL remain the entry-point file.
      (Chose the optional-parameter form: `loadFactory(sourcePath,
      callerCwd = process.cwd())`. The cli.ts caller now passes its
      `cwd` through.)
- [x] 2.6 Confirm a factory file with no `extends:` field still
      loads identically to today (no chain walk, same validation
      pass, no behavior change). All 19 pre-existing loader tests
      still pass against the refactored loader.

## 3. Resolver: lookup precedence + `minifac:` prefix

- [x] 3.1 In `src/cli/resolve.ts`, refactor `resolveFactoryByName`
      to:
      - Accept a `<name>` argument that may carry a `minifac:` prefix.
      - For `minifac:<name>`: resolve to
        `<cwd>/examples/<name>.yaml` only; do not try local.
      - For bare `<name>`: try
        `<cwd>/.minifac/factories/<name>.yaml` first, then
        `<cwd>/examples/<name>.yaml`. Return the first that exists.
      - On miss, throw `RunArgResolutionError` naming all paths
        tried.
- [x] 3.2 Extend `resolveRunArg`'s step 3 (factory-by-name) to use
      the new lookup. The bare `<thing>` CLI arg uses the same
      precedence as a brief's bare `factory:` field.
- [x] 3.3 In the brief-loaded paths (steps 1 and 2), pass the brief's
      `factory:` field (which may carry the `minifac:` prefix)
      through the same `resolveFactoryByName`.
- [x] 3.4 Update the docstring at the top of `resolve.ts` to describe
      the two-step lookup and the `minifac:` prefix; remove or
      update the existing v0-stopgap comment now that composition
      is shipping.

## 4. `minifac init` subcommand

- [x] 4.1 Add an `init` subcommand to `src/cli.ts` (via Commander).
      Accept `--with-sdd` boolean flag. No positional arguments.
- [x] 4.2 Implement the action:
      - Create `inputs/` if missing.
      - Create `.minifac/` if missing.
      - Create `.minifac/factories/` if missing, plus a
        `.minifac/factories/README.md` explaining the convention
        (and how `extends:` works at a glance).
      - When `--with-sdd` is set and
        `.minifac/factories/sdd.yaml` does not exist, write the
        starter file (`extends: "minifac:sdd"` and nothing else).
      - Print a one-line summary to stdout naming what was
        created (or "already initialized" / similar) and exit `0`.
      (Action lives in `src/cli/init.ts`; the Commander wiring is
      in `src/cli.ts`.)
- [x] 4.3 Surface fatal I/O errors (e.g. EACCES) with a stderr line
      naming the offending path and the underlying error, then
      exit `1`. Use the existing `describeError`-style path if
      convenient.
      (Returns 1 with `minifac init failed: <path>: <message>` from
      the action; the existing `describeError` path didn't fit
      cleanly since the action owns its own error formatting and
      doesn't throw out to Commander.)
- [x] 4.4 Confirm the subcommand makes no network call, no `git`
      call, and writes only to the four documented paths.
      (Inspection of `src/cli/init.ts`: only `mkdir`, `stat`,
      `writeFile` against `inputs/`, `.minifac/`,
      `.minifac/factories/`, and conditionally
      `.minifac/factories/sdd.yaml` + `.minifac/factories/README.md`.
      No `child_process`, no `fetch`, no other I/O.)

## 5. Tests

- [x] 5.1 Loader: factory without `extends:` loads identically to
      pre-change behavior (regression guard). The existing 19
      `loader.test.ts` cases stand as the regression suite.
- [x] 5.2 Loader: `extends: "minifac:hello"` resolves to
      `examples/hello.yaml` and returns the merged factory.
- [x] 5.3 Loader: `extends: "<name>"` resolves to
      `.minifac/factories/<name>.yaml`.
- [x] 5.4 Loader: missing base (`minifac:` form) throws
      `FactoryLoadError` naming the absolute path tried and the
      entry-point file.
- [x] 5.5 Loader: missing base (local form) throws
      `FactoryLoadError` naming the absolute path tried and the
      entry-point file.
- [x] 5.6 Loader: cyclic chain (a → b → a) throws
      `FactoryLoadError` whose message lists the file sequence.
- [x] 5.7 Loader: self-referential `extends:` throws
      `FactoryLoadError`.
- [x] 5.8 Loader: path-like `extends:` (`./foo.yaml`,
      `../bar.yaml`) throws `FactoryLoadError`.
- [x] 5.9 Loader: replace-at-node-level — override one node, others
      preserved verbatim from base (deep-equal comparison).
- [x] 5.10 Loader: derived layer adds a new node; resolved factory
       has both base and new nodes.
- [x] 5.11 Loader: derived layer declares `edges: [...]` →
       resolved `edges` is exactly the layer's edges (base edges
       discarded).
- [x] 5.12 Loader: derived layer omits `edges:` → resolved `edges`
       equals base edges unchanged.
- [x] 5.13 Loader: derived layer declares `name`, `description`,
       `brief` → resolved factory has the layer's values; if
       omitted, inherits from base.
- [x] 5.14 Loader: resolved factory has no `extends` property on
       the returned object (downstream consumers can rely on the
       field being stripped).
- [x] 5.15 Loader: post-schema validation runs against the
       resolved factory (e.g. override that removes the only
       terminal node fails with the existing terminal-required
       error, citing the entry-point file's `sourcePath`).
- [x] 5.16 Resolver: bare factory name prefers
       `.minifac/factories/<name>.yaml` over
       `examples/<name>.yaml`.
- [x] 5.17 Resolver: bare factory name falls back to
       `examples/<name>.yaml` when local is missing.
- [x] 5.18 Resolver: `minifac:<name>` skips local lookup even when
       a local file exists. (Tested via the CLI integration test
       in 5.22 — `resolveFactoryByName` exercises the same code
       path that the brief's `factory:` field flows through.)
- [x] 5.19 Resolver: `minifac:<name>` with no matching built-in
       returns a `RunArgResolutionError` naming the path tried.
- [x] 5.20 Resolver: missing-everywhere bare name returns a
       `RunArgResolutionError` naming both paths tried.
- [x] 5.21 CLI (`minifac run`): brief with `factory: sdd` resolves
       to the local custom when present (integration test using
       the `io.runCwd` injection point already in `cli.ts`).
- [x] 5.22 CLI (`minifac run`): brief with `factory: minifac:sdd`
       resolves to the built-in even when a local exists.
- [x] 5.23 CLI (`minifac init`): on an empty directory, creates
       `inputs/`, `.minifac/`, `.minifac/factories/`, and the
       README; prints a summary; exits `0`.
- [x] 5.24 CLI (`minifac init`): idempotent — second invocation
       is a no-op, exits `0`.
- [x] 5.25 CLI (`minifac init --with-sdd`): writes
       `.minifac/factories/sdd.yaml` with `extends:
       "minifac:sdd"`; the produced file loads cleanly via
       `loadFactory` (round-trip check).
- [x] 5.26 CLI (`minifac init --with-sdd`): does not overwrite an
       existing `.minifac/factories/sdd.yaml`; exits `0`.

## 6. Documentation

- [x] 6.1 Update `docs/concepts/Factory.md`'s "Composition" section
      with a worked example: a `.minifac/factories/sdd.yaml` that
      `extends: "minifac:sdd"` and overrides the `verify` node's
      `with.prompt` (or equivalent) to swap `npm test` for
      `bun test`. Show the file as-on-disk, not just prose.
- [x] 6.2 Add a "Customizing the SDD factory for your repo" section
      to `examples/sdd.md` (or `README.md` — author's call) that
      points users at `minifac init` and the composition mechanism.
- [x] 6.3 Update the brief authoring docs (the skill at
      `src/skills/brief-authoring/SKILL.md` if it exists, or the
      brief-schema spec's narrative) to note that `factory:` can
      target a local custom factory or a `minifac:`-prefixed
      built-in.
      (The brief-authoring skill lives at
      `.claude/skills/brief-authoring/SKILL.md`; updated the
      "Confirm the factory" step with the two-form note.)

## 7. Verify

- [x] 7.1 Run the full test suite; all pre-existing tests pass plus
      the new tests added above.
      Result: 288/288 passing (267 pre-existing + 17 new
      extends tests + 5 new init tests + 6 new resolver tests +
      2 new CLI composition integration tests; the new tests
      span four new test files).
- [x] 7.2 Manually `minifac init` in a scratch directory and
      confirm the structure is created and is idempotent on
      re-run; `minifac init --with-sdd` writes a starter file that
      loads cleanly.
      Exercised in a `mktemp -d` scratch dir from the built
      `dist/cli.js`: `init` created `inputs/`, `.minifac/`,
      `.minifac/factories/README.md`; a second `init` printed
      "already initialized"; `init --with-sdd` then wrote
      `.minifac/factories/sdd.yaml` containing
      `extends: "minifac:sdd"`.
- [x] 7.3 Manually exercise the resolver: a brief with `factory:
      sdd` and a `.minifac/factories/sdd.yaml` that
      `extends: "minifac:sdd"` and overrides a node — run via
      `minifac run inputs/<brief>.md` and confirm the override
      took effect (the overridden node's prompt is what the runner
      dispatched).
      Built a scratch dir with `examples/sdd.yaml`,
      `.minifac/factories/sdd.yaml` (extends + override of node
      `a`'s prompt), and `inputs/manual-test.md`. Walked it
      through `resolveRunArg` + `loadFactory`; the resolver
      returned the `.minifac/factories/sdd.yaml` path and the
      loaded factory's node `a` prompt was the override value
      (`from-local-override`), not the base value
      (`from-builtin`).
- [x] 7.4 Run `openspec validate factory-composition` and confirm
      clean. Result: `Change 'factory-composition' is valid`
      (also passes `--strict`).
