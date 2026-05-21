## 1. Step schema and loader

- [x] 1.1 Create `src/step/schema.ts` with a Zod schema for the step
      file (`name`, `version`, optional `description`, optional
      `inputs`, `executor`, `with`). Strict on extras at the top
      level. `name` SHALL match `[a-z][a-z0-9-]*`; `version` SHALL
      be a non-empty string.
- [x] 1.2 In `src/step/schema.ts`, model the input definition shape
      as a discriminated union or explicit object with `type`
      (`"string" | "number" | "boolean" | "array" | "object"`),
      optional `required` (boolean, default `false`), optional
      `default`, and optional `description`. Strict on extras.
      Default value's type SHALL match `type` (cross-field check).
- [x] 1.3 Reject a step input whose `required: true` also declares
      a `default`, with a clear error.
- [x] 1.4 Create `src/step/loader.ts` with a `loadStep(absPath:
      string): Promise<LoadedStep>` that reads, parses YAML
      (sharing the same YAML library as the factory loader),
      validates against the step schema, and returns the typed
      result. Surface errors as `StepLoadError` (new class in
      `src/step/loader-error.ts`) carrying `sourcePath`, the
      offending field/value where applicable, and the YAML line
      number for malformed YAML (matching the factory loader's
      reporting style).
- [x] 1.5 Add unit tests in `src/step/loader.test.ts` covering:
      minimal valid step, missing required top-level keys
      (`name`, `version`, `executor`, `with`), unknown top-level
      key, camel-case keys, malformed YAML reports line number,
      non-string `name`, empty `version`, input definition
      shapes (`string` / `number` / `boolean` / `array` /
      `object`), invalid `type` literal, missing `type`, unknown
      key in input def, invalid input name, required-with-default
      rejection, type-of-default mismatch.

## 2. Step reference resolution

- [x] 2.1 Create `src/step/resolve.ts` exporting `parseStepRef(ref:
      string): { scope?: string; name: string; version?: string;
      builtinForced: boolean }` that parses the three accepted
      forms: `minifac:<name>[@<version>]` (with the prefix-colon
      that forces built-in), `<scope>/<name>[@<version>]`, and
      bare `<name>[@<version>]`. Reject path-like values
      (separators outside the single `<scope>/<name>` separator),
      values with whitespace, empty strings, empty pin (trailing
      `@`), and the empty-name case.
- [x] 2.2 In the same module, export `resolveStepRef(ref: string,
      callerCwd: string): Promise<string>` that returns the
      absolute path of the resolved step file:
      - `minifac:<name>` → `<callerCwd>/examples/steps/<name>.yaml`
        (built-in-only; if missing, throw).
      - `<scope>/<name>` and bare `<name>` → try
        `<callerCwd>/.minifac/steps/<name>.yaml` first, then
        `<callerCwd>/examples/steps/<name>.yaml`.
      - On miss, throw `StepLoadError` naming the reference and
        every path tried in order.
      - Version pins are parsed but ignored for resolution in v0.
- [x] 2.3 Add unit tests in `src/step/resolve.test.ts` covering:
      built-in-forced resolution, built-in-forced skip-local even
      when local exists, bare-name local-preferred, bare-name
      built-in fallback, missing bare reference, missing
      built-in-forced reference, path-like rejection,
      whitespace rejection, empty-pin rejection, `@1` and
      `@1.0.0` parse and resolve the same as unversioned,
      unversioned and pinned references resolve to the same
      file.

## 3. Step inlining helper

- [x] 3.1 Create `src/step/inline.ts` exporting
      `inlineStepIntoNode({ factoryPath, nodeId, node, callerCwd
      }): Promise<ResolvedNode>` that:
      - Resolves the node's `uses:` reference to an absolute path
        (calling `resolveStepRef`).
      - Loads the step at that path (calling `loadStep`).
      - Validates the node's `inputs:` map against the step's
        input schema: rejects missing required, rejects type
        mismatch (`typeof value` for `string`/`number`/`boolean`;
        `Array.isArray` for `array`; plain-object check for
        `object` — not null, not array, not other typed values),
        rejects unknown keys, fills in defaults for omitted
        optional inputs.
      - Applies `{{ inputs.* }}` substitution into the step's
        `with` object (deep walk: strings get token-replaced;
        non-string fields pass through structurally). For
        non-string inputs that appear in string templates,
        stringify (`String(value)` for scalars; `JSON.stringify`
        for arrays/objects). Null/undefined input values
        substitute as empty string.
      - Returns a resolved node carrying `executor: <step.executor>`,
        `with: <substituted step.with>`, plus the node's own
        `terminal`, `max_iterations`, and `cwd` fields. The
        returned node SHALL NOT carry `uses` or `inputs`.
- [x] 3.2 Surface validation failures as
      `FactoryLoadError` (re-exported from
      `src/factory/loader-error.ts`) carrying the factory's
      `sourcePath`, the node id, the step's `sourcePath`, and a
      message specific to the failure (missing required input,
      type mismatch, unknown input key, malformed reference,
      missing step file).
- [x] 3.3 Decide: do brief/run tokens in factory input values
      survive untouched into the inlined body? The expected
      answer (per the `factory-schema` spec delta) is YES —
      brief and run are not in scope at load. Implement
      accordingly: a factory input value of `"{{ brief.change
      }}"` passes the step's `type: "string"` check and is
      inlined verbatim; the runner's existing brief/run
      substitution handles it at dispatch.
- [x] 3.4 Add unit tests in `src/step/inline.test.ts` covering:
      string input → string field, number input stringifies into
      string field, boolean input stringifies, array input
      JSON-stringifies, object input JSON-stringifies, null
      input → empty string, optional input omitted (with default)
      → default is inlined, optional input omitted (no default)
      → token substitutes to empty string at dispatch time
      (verify the token survives load and resolves at dispatch
      via the runner's substitution pass), missing required
      input rejected, type mismatch rejected, unknown input key
      rejected, brief/run tokens in input values survive
      verbatim into the inlined body.

## 4. Factory schema and loader integration

- [x] 4.1 In `src/factory/schema.ts`, extend the node schema to
      accept `uses: z.string().min(1).optional()` and `inputs:
      z.record(...).optional()` alongside the existing
      `executor`, `with`, `terminal`, `max_iterations`, `cwd`.
      Keep the node strict on extras. The schema layer SHALL NOT
      enforce the mutual-exclusion rule between `uses:` and
      `executor:`/`with:` (Zod doesn't express it cleanly across
      sibling fields); enforce it in a post-schema validator.
- [x] 4.2 Add a post-schema validator that walks each node and
      rejects:
      - `uses:` together with `executor:` or `with:` (mutual
        exclusion).
      - `inputs:` without `uses:` (orphan inputs).
      - Neither `uses:` nor `executor:` (missing-required-field).
      Emit `FactoryLoadError` with the node id and a message
      describing the rule violation.
- [x] 4.3 In `src/factory/loader.ts`, slot step inlining between
      `extends:` resolution and post-schema validation. After the
      `resolveExtendsChain(...)` step returns the merged factory,
      iterate the merged factory's nodes; for each node that
      carries `uses:`, call `inlineStepIntoNode` and replace the
      node in place with the resolved-flat node. Pass the caller
      cwd through. Then run the existing `validatePostSchema`
      against the resulting flat factory.
- [x] 4.4 Confirm an inline-only factory (no `uses:` anywhere)
      loads identically to today: no step resolution attempted,
      no behavior change. The pre-existing factory loader tests
      stand as the regression suite for this case.
- [x] 4.5 Add unit tests in `src/factory/loader.test.ts` (or a new
      sibling) covering: node with `uses:` and no `inputs:`
      loads when defaults satisfy the schema; node with `uses:`
      and `inputs:` loads; node with both `uses:` and `executor:`
      is rejected; node with both `uses:` and `with:` is
      rejected; node with `inputs:` but no `uses:` is rejected;
      node with neither `uses:` nor `executor:` is rejected;
      node with empty `uses:` is rejected; node with non-string
      `uses:` is rejected; node-level fields (`terminal`,
      `cwd`) stay on the node alongside `uses:`; unknown
      node-level key is still rejected.
- [x] 4.6 Add integration tests for inlining order:
      `extends:` resolution happens first (a derived layer that
      redeclares a node to `uses:` resolves the step at the
      derived layer); step inlining happens before post-schema
      validation (a resolved factory whose terminal node was
      defined inline by the base survives; a missing step
      reference fails before validation reports start-node
      issues).
- [x] 4.7 Add a test that the resolved factory carries no `uses`
      or `inputs` property on any node (regression guard for
      the runner-doesn't-see-steps invariant).

## 5. Runner templating: `{{ inputs.* }}`

- [x] 5.1 Extend `src/factory/templating.ts` (or the equivalent
      brief/run substitution module) to recognize a third
      namespace `inputs` in the token grammar. The grammar
      already matches `{{ <ns>.<field> }}`; add `"inputs"` to
      the accepted namespace set.
- [x] 5.2 Thread a per-node `inputs` map through the runner's
      dispatch path so the substitution pass can resolve
      `{{ inputs.<field> }}` tokens. Source: the inputs map
      attached at step inlining time. For inline nodes (never
      inlined from a step), the inputs map SHALL be undefined,
      and the substitution pass SHALL leave `inputs.*` tokens
      verbatim.
- [x] 5.3 Decision check: does the per-node inputs map live on
      the resolved node (e.g. as a non-enumerable property) so
      the runner can pick it up, or is it injected by the
      factory loader into a separate side-channel? Pick one and
      document briefly in code. (Recommendation: a
      non-enumerable property on the resolved node, so it
      doesn't appear in serialized factory snapshots and is
      cheap to look up at dispatch.)
- [x] 5.4 Implement value stringification rules: strings pass
      verbatim; numbers/booleans via `String(value)`;
      arrays/objects via `JSON.stringify(value)`; null/undefined
      → empty string. Match the `graph-runner` spec delta's
      scenarios exactly.
- [x] 5.5 Add unit tests in `src/factory/templating.test.ts`
      covering: string input → string substitution; number
      stringification; boolean stringification; array
      JSON-stringification; object JSON-stringification; absent
      optional input → empty string; null input → empty string;
      inline node (no inputs map) leaves `inputs.*` verbatim;
      `{{ inputs.* }}` and `{{ brief.* }}` cooperate when an
      input value is itself a brief token.
- [x] 5.6 Confirm `cwd` template substitution also sees the
      `inputs` namespace (per the `graph-runner` spec's grammar:
      both `with.prompt` and `cwd` are substituted, all
      namespaces). Add a covering test.

## 6. Migrate `examples/sdd.yaml` to use steps

- [x] 6.1 Create `examples/steps/openspec-propose.yaml`. Declare
      inputs (`change: { type: "string", required: true }`,
      `brief_body: { type: "string", required: true }`).
      Move the existing propose prompt from `examples/sdd.yaml`
      into the step's `with.prompt`, replacing `{{ brief.change }}`
      and `{{ brief.body }}` tokens with `{{ inputs.change }}` and
      `{{ inputs.brief_body }}` so the step is brief-agnostic.
      Set `with.permission_mode: "bypass_permissions"` and
      `executor: claude`.
- [x] 6.2 Create `examples/steps/openspec-apply.yaml`. Inputs:
      `change: { type: "string", required: true }`. Body: the
      existing apply prompt, with `{{ brief.change }}` →
      `{{ inputs.change }}`.
- [x] 6.3 Create `examples/steps/openspec-verify.yaml`. Inputs:
      `change: { type: "string", required: true }`,
      `commands: { type: "array", default: ["npm test",
      "npm run build", "npm run check"] }`. Body: the existing
      verify prompt, with `{{ brief.change }}` → `{{ inputs.change }}`
      and the verify-commands list referenced via
      `{{ inputs.commands }}` if the existing prompt enumerates
      them; otherwise leave the verbatim command listing in the
      prompt and document `commands` as advisory for now (defer
      a richer enumeration to a follow-on).
- [x] 6.4 Create `examples/steps/openspec-archive.yaml`. Inputs:
      `change: { type: "string", required: true }`. Body: the
      existing archive prompt, with `{{ brief.change }}` →
      `{{ inputs.change }}`.
- [x] 6.5 Rewrite `examples/sdd.yaml` to reference the four steps:
      ```yaml
      nodes:
        propose:
          uses: minifac:openspec-propose
          inputs:
            change: "{{ brief.change }}"
            brief_body: "{{ brief.body }}"
          cwd: "{{ run.cwd }}"
        apply:
          uses: minifac:openspec-apply
          inputs:
            change: "{{ brief.change }}"
          cwd: "{{ run.cwd }}"
        verify:
          uses: minifac:openspec-verify
          inputs:
            change: "{{ brief.change }}"
          cwd: "{{ run.cwd }}"
        archive:
          uses: minifac:openspec-archive
          inputs:
            change: "{{ brief.change }}"
          cwd: "{{ run.cwd }}"
          terminal: true
      ```
      Keep the top-level `name: sdd`, `description: ...`,
      `brief: required`, and `edges:` block unchanged. The file
      shrinks from ~150 lines to ~40.
- [x] 6.6 Update the structural test
      `src/factory/sdd-example.test.ts` to assert against the
      *resolved* factory shape (post step inlining), not the
      raw on-disk shape. The test now checks: four nodes named
      `propose`/`apply`/`verify`/`archive`; resolved
      `with.prompt` for each contains the documented `{{ brief.* }}`
      tokens; every resolved `cwd === "{{ run.cwd }}"`;
      every resolved `with.permission_mode === "bypass_permissions"`;
      no resolved `with` declares `allowed_tools` or `add_dirs`;
      no resolved prompt contains `<CHANGE_NAME>`,
      `/path/to/target/repo`, or the literal substring
      `MINIFAC_STATUS`; the topology / budgets / edges /
      `brief: required` declarations are unchanged.
- [x] 6.7 Add a regression test that loads
      `examples/sdd.yaml` and deep-equals the resolved factory's
      shape against a fixture snapshot. The fixture
      can be a JSON file checked into the test directory or an
      inline object literal in the test. Whitespace
      normalization on prompt strings is acceptable; the goal
      is to catch unintended drift in node bodies during future
      refactors.
- [x] 6.8 Update `examples/sdd.md` to teach both authoring shapes:
      the inline shape (still supported) and the `uses:` shape
      (now used by the shipped factory). Point readers at
      `examples/steps/` as the canonical step library.

## 7. `minifac steps` CLI subcommand

- [x] 7.1 Add a `steps` subcommand in `src/cli.ts` (via Commander).
      Accept `--source <local | built-in | all>` (default `all`)
      and `--json`. The action lives in
      `src/cli/steps.ts`.
- [x] 7.2 Implement the action: scan `<cwd>/.minifac/steps/*.yaml`
      and `<cwd>/examples/steps/*.yaml` (filtering by
      `--source`). For each file, attempt `loadStep`. On
      success, collect `{ name, version, source, path,
      description }`. On failure, collect a placeholder row with
      the loader error message. Sort by source then name.
- [x] 7.3 Default output: plain-text table with columns
      `NAME`, `VERSION`, `SOURCE`, `DESCRIPTION`. Truncate
      description to fit the terminal width. Emit a one-line
      summary on empty results.
- [x] 7.4 With `--json`: emit a JSON array of the same objects.
      Stable ordering. Exit `0` on success; `1` on usage error
      or fatal I/O.
- [x] 7.5 Reject unrecognized `--source` values as a usage error
      (`1` exit), writing the supported set to stderr.
- [x] 7.6 Confirm the subcommand makes no network call, no
      `git` call, and writes nothing to disk.
- [x] 7.7 Add tests in `src/cli/steps.test.ts` covering: lists
      built-ins only when no local exists; `--source local`
      filters; `--source built-in` filters; `--json` emits a
      parseable array; same-name local and built-in both appear
      in `--source all`; empty directories produce an
      empty-listing message; malformed step file appears with
      an error placeholder; unrecognized `--source` exits `1`.

## 8. Documentation

- [x] 8.1 Update `docs/concepts/Factory.md` to add a "Steps"
      section. Worked example: a factory whose node declares
      `uses: minifac:openspec-verify` with `inputs:` mapped from
      the brief. Show the on-disk shape, not just prose. Cross-link
      to `Step.md`.
- [x] 8.2 Verify `docs/concepts/Step.md` against what shipped.
      Tweak if needed so the document accurately describes the
      lookup precedence, the templating scopes, and the
      versioning model that landed.
- [x] 8.3 Update `examples/sdd.md` (already touched in task 6.8;
      consolidate any remaining edits here). Make sure the doc
      teaches the user that the shipped factory now uses
      `uses:` and that the step bodies live in
      `examples/steps/`.
- [x] 8.4 Add a short "Reusable steps" section to `README.md`
      pitching this as the composition story (alongside the
      existing `extends:` mechanism). Reference
      `Factory.md` → "Steps" and `Step.md` for the deep dive.

## 9. Verify

- [x] 9.1 Run the full test suite; all pre-existing tests pass
      plus the new tests added above (step loader, resolver,
      inliner, factory loader integration, templating,
      `minifac steps`, SDD structural + regression).
- [x] 9.2 Run `openspec validate reusable-steps` and confirm
      clean (also under `--strict`).
- [x] 9.3 Manually invoke `minifac steps` in a scratch directory
      seeded with `examples/steps/*.yaml` and confirm the
      table / JSON output matches the spec.
- [x] 9.4 Manually invoke `minifac run` against a brief whose
      `factory: sdd` resolves to the migrated `examples/sdd.yaml`
      (e.g. one of the briefs in `inputs/`). Confirm the run
      produces the same shape of run as before — same four
      nodes, same prompts substituted with brief data, same
      `cwd` resolution, same authority controls. Capture the
      run id and compare a sampling of node prompts to the
      pre-migration shape (e.g. via the `runs show` subcommand)
      to confirm no behavior drift.
