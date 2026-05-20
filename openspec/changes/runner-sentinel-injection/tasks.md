## 1. Executor: schema and validation

- [x] 1.1 Extend `WithSchema` in `src/executor/claude.ts` with a new
      optional field `emit_sentinel_instructions: z.boolean().optional()`.
      Keep `.strict()` on the object.
- [x] 1.2 Confirm the existing zod parse-failure path produces a
      `failed` status with `meta: { reason: "invalid_with", ... }` for
      non-boolean values in the new field (no special-casing needed —
      the existing pathway covers it).

## 2. Executor: sentinel instruction block constant

- [x] 2.1 Define a single exported module-level constant
      `SENTINEL_INSTRUCTIONS` in `src/executor/claude.ts` containing
      the canonical prompt-tail block: it names the two literal
      acceptable endings (`MINIFAC_STATUS: succeeded` /
      `MINIFAC_STATUS: failed` + `REASON: <one line>`), states that
      the marker must appear in the model's final assistant message,
      and states that the marker must be the last thing in the
      message.
- [x] 2.2 Co-locate the constant with `SENTINEL_REGEX` in the source
      file. Add a one-line comment cross-referencing the two so a
      reader sees they describe the same contract from opposite
      sides (instructions to the model vs. parse rule applied to its
      response).

## 3. Executor: prompt assembly

- [x] 3.1 In `ClaudeExecutor.run`, after the `WithSchema.safeParse`
      step, compute the effective prompt: when
      `parsed.data.emit_sentinel_instructions !== false`, append
      `"\n\n" + SENTINEL_INSTRUCTIONS` to the prompt string before
      calling `buildStreamJsonInput`; when `false`, pass the prompt
      through unchanged.
- [x] 3.2 Confirm by reading that `buildStreamJsonInput`'s signature
      and behavior are unchanged — the assembly happens at the call
      site, not inside the helper. (Keeps the helper's snapshot
      identity for callers that want bare-payload framing in tests.)

## 4. Source documentation

- [x] 4.1 Update the wire-format comment block at the top of
      `src/executor/claude.ts`:
      (a) describe the auto-injection contract (default-on; runner
          appends `SENTINEL_INSTRUCTIONS` to the prompt before
          framing),
      (b) describe the `emit_sentinel_instructions` opt-out and that
          parsing is unaffected by it,
      (c) cross-reference the canonical spec requirements in
          `openspec/specs/node-executor/spec.md`.
- [x] 4.2 Add the new field row to the "Authority knobs" subsection
      of the wire-format comment (or to a sibling subsection if it
      doesn't fit semantically with the authority knobs — the field
      is sentinel-side, not authority-side).

## 5. SDD example factory migration

- [x] 5.1 In `examples/sdd.yaml`, delete the `## Status signaling`
      block from each of the four nodes' prompts (`propose`, `apply`,
      `verify`, `archive`). Preserve everything above the block —
      the per-node responsibility paragraphs and any
      success/failure criteria already stated in prose stay as-is.
- [x] 5.2 For each node, audit the surrounding prose to confirm the
      success and failure criteria are still legible without the
      deleted block. Inline a one-sentence criteria note where the
      pre-deletion block was the only explicit statement of the
      criterion. Per-node target wording:
      - **propose:** mentions `openspec validate <CHANGE_NAME>`
        exiting 0 and the required artifacts being on disk for
        success; failure means validate stays dirty or an artifact
        cannot be written.
      - **apply:** mentions every `- [ ]` in `tasks.md` becoming
        `- [x]` for success; failure means a task is structurally
        blocked.
      - **verify:** mentions every verify command exiting 0 for
        success; failure names the failing command and the
        diagnosable output that the next `apply` iteration will
        read out of `ctx.history`.
      - **archive:** mentions both `openspec archive <CHANGE_NAME>`
        and the subsequent `git commit` exiting 0 for success;
        failure names which step failed and the relevant error.
- [x] 5.3 In `examples/sdd.md`:
      (a) Update the "Status signaling" section to say the runner
          injects the sentinel mechanics — the section still
          documents the regex and precedence as reference, but
          notes that factory authors do NOT re-state them in their
          prompts.
      (b) Remove the "If you author a custom node prompt, drop this
          block at the end" recipe and replace it with a note that
          custom prompts get the mechanics for free; explicitly
          opting out via `emit_sentinel_instructions: false` makes
          the prompt author responsible for any sentinel mechanics
          they want.
      (c) Update each per-node contract bullet so the
          "Success signal" / "Failure signal" sub-bullets focus on
          the *criteria* (e.g. "every verify command exits 0")
          rather than re-stating the sentinel format.
      (d) Add a migration note (alongside the existing migration
          notes) telling copiers of pre-this-change `sdd.yaml`
          files that the `## Status signaling` block in each node
          can be deleted; the runner injects the same content now.

## 6. Tests: SDD structural

- [x] 6.1 In `src/factory/sdd-example.test.ts`, delete the existing
      assertion `it("instructs every node prompt to emit
      MINIFAC_STATUS", ...)`. The sentinel mechanics are no longer
      the factory's job to author.
- [x] 6.2 Add a replacement assertion `it("declares per-node
      success/failure criteria", ...)` that loads the factory and,
      for each node, asserts the prompt contains a domain-specific
      substring confirming its criterion is still in the YAML:
      - `propose.prompt` contains `openspec validate`
      - `apply.prompt` contains `tasks.md`
      - `verify.prompt` contains `verify` (lowercase substring),
        capturing the "verify command" criterion language
      - `archive.prompt` contains `openspec archive` AND `git commit`
- [x] 6.3 Add (or reuse the existing `it("instructs the archive
      node to commit the archive moves", ...)`) an explicit
      assertion that the archive prompt still mentions the
      `git commit` step (this assertion is already present and
      passes today; confirm it still passes after the sentinel
      block deletion). No code change here unless 6.2's coverage
      already subsumes it — in which case delete the duplicate.

## 7. Tests: executor

- [x] 7.1 Add a test `buildCliArgs` is unaffected — the existing
      argv snapshots stay green. (Sanity check: the change does
      not touch argv construction. If snapshots drift, that's a
      bug.)
- [x] 7.2 Add a snapshot test for the constructed stdin payload
      with default `emit_sentinel_instructions` (omitted) and a
      representative prompt + empty history. The snapshot SHALL
      capture the full envelope line so future changes to
      `SENTINEL_INSTRUCTIONS` (or to envelope framing) require an
      explicit snapshot update.
- [x] 7.3 Add a test that `emit_sentinel_instructions: false`
      produces a constructed stdin payload whose user-message
      content equals exactly `<history JSON>\n\n---\n\n<prompt>`
      with no appended block. Compare the parsed envelope's
      `message.content` field against a literal string.
- [x] 7.4 Add a test that `emit_sentinel_instructions: true`
      produces the same payload as the omitted-field case (proves
      the explicit-on path matches the default).
- [x] 7.5 Add a test that a non-boolean value in
      `emit_sentinel_instructions` (e.g. `"yes"`) yields a
      terminal `failed` status with `meta.reason === "invalid_with"`
      and no child spawn. Mirrors the existing pattern for the
      other invalid-`with` cases.
- [x] 7.6 Add a test that the response-side sentinel parse is
      unaffected by `emit_sentinel_instructions: false`: a child
      that emits a final `result.result` containing
      `MINIFAC_STATUS: failed\nREASON: opted out anyway` still
      produces a `sentinel_failed` terminal even though the
      executor sent no instruction block. (Confirms parsing and
      injection are independent.)

## 8. Verify

- [x] 8.1 Run the full test suite. All existing tests SHALL pass.
      The only newly-modified existing test is
      `src/factory/sdd-example.test.ts` (per task 6.1); the only
      newly-modified snapshot is the executor's new stdin-payload
      snapshot (added, not modified).
- [x] 8.2 Run `npm run build` and `npm run check` to confirm no
      type or lint regression.
- [x] 8.3 Run `openspec validate runner-sentinel-injection
      --strict` and confirm clean exit.
- [x] 8.4 (Manual, deferred) Spot-check that running `minifac run
      examples/sdd.yaml` (against a sacrificial target repo) still
      produces sentinel-driven node outcomes. Not run during the
      propose phase; called out for the apply phase.
      (Apply-phase note: not run during apply either — requires a
      real `claude` invocation against a sacrificial target repo,
      which is outside the apply node's `cwd`. The behavior is
      pinned at the unit level by the new snapshot in
      `src/executor/claude.test.ts` and the response-side parse
      tests already present. The full live spot-check belongs to a
      human running `minifac run` after the change archives.)
