## 1. Factory schema — `outputs:` block

- [x] 1.1 Add `OutputValueSchema`, `OutputFileSchema`,
      `OutputDirectorySchema`, and the `OutputDefSchema`
      discriminated union to `src/factory/schema.ts`. Each
      branch is strict-on-extras; `value` accepts an opaque
      `shape` slot reserved for future structural typing.
- [x] 1.2 Add `outputs: z.record(<keyRegex>, OutputDefSchema).optional()`
      to the node shape. The key regex MUST match the regex
      already used for step input keys
      (`^[a-zA-Z_][a-zA-Z0-9_]*$`). Reject `filename` strings
      with path separators or empty values.
- [x] 1.3 Extend the existing node-level accepted-key-set
      validator (used for strict-on-extras) to include `outputs`.
- [x] 1.4 Confirm `extends:` merging preserves `outputs:` per
      the replace-at-node-level rule (the entire node is
      replaced; no field-level merging — already covered by
      the existing semantics, just add a test).
- [x] 1.5 Add `OutputDef` and `NodeOutputIndex` types to the
      factory-schema exports (or to `src/factory/types.ts` if
      that's where node-level types live) so `executor/types.ts`
      and `runner/run.ts` can import them.
- [x] 1.6 Tests in `src/factory/schema.test.ts` covering all
      "Node `outputs:` block" and "`OutputDef` discriminated
      types" scenarios from the factory-schema delta.

## 2. Substitution token grammar

- [x] 2.1 Extend `Substitutions` in `src/runner/substitute.ts`
      to include `outputsDir?: string` and `priorResults?:
      ReadonlyMap<string, NodeResult>` (latest entry per nodeId).
- [x] 2.2 Update the substitute regex to match the new token
      forms: `{{ run.outputs_dir }}`,
      `{{ priorResults.<node-id>.outputs.<key> }}`, and
      `{{ priorResults.<node-id>.outputs.<key>:read }}`.
- [x] 2.3 Implement the resolution rules: `run.outputs_dir` →
      the resolved per-node-per-iteration directory path;
      `priorResults.X.outputs.Y` → absolute path string (or
      empty string when not found); `:read` suffix → file
      contents with 64 KB cap (throw on oversize; throw on
      directory output).
- [x] 2.4 Tests in `src/runner/substitute.test.ts` covering
      every scenario added to the graph-runner "Brief token
      substitution" requirement.

## 3. Runner — outputs directory + validation

- [x] 3.1 In `src/runner/run.ts`, compute `outputsDir =
      ${MINIFAC_HOME}/outputs/<runId>/<nodeId>/<iteration>/`
      per dispatch. Mint a UUID-shaped run id when no store is
      in scope (so directory paths are stable in tests).
- [x] 3.2 mkdirp the outputs directory (recursive, `0o755`)
      before invoking the executor.
- [x] 3.3 Thread `outputsDir` through `RunContext` to every
      executor (extend `ctx` per the `executor/types.ts` shape).
- [x] 3.4 After the executor terminates and the terminal status
      resolves, run `validateDeclaredOutputs(node, outputsDir,
      finalStatus)`. Implement the validator per the
      "Post-execution outputs validation" requirement: scan
      each declared output, parse value-outputs as JSON, glob
      file-outputs, walk directory-outputs, build the
      `NodeOutputIndex` of present-and-satisfied entries, and
      compute the missing-required set.
- [x] 3.5 When the missing set is non-empty AND the node's
      terminal status was `succeeded`, override the status to
      `failed` with reason `missing_required_output` and
      `meta.missing_outputs` / `meta.missing_outputs_detail`.
      Preserve the partial index on the failure metadata.
- [x] 3.6 When the node terminated `failed` for any reason
      OTHER than missing-output, skip validation entirely and
      leave `NodeResult.outputs = null`.
- [x] 3.7 Tests in `src/runner/run.test.ts` covering every
      scenario in the "Post-execution outputs validation",
      "Per-node-per-iteration outputs directory", and
      "`NodeResult.outputs` field on prior results"
      requirements.

## 4. `NodeResult.outputs` + priorResults plumbing

- [x] 4.1 Add `outputs: NodeOutputIndex | null` to `NodeResult`
      in `src/executor/types.ts`.
- [x] 4.2 Populate `outputs` from the validator's result when
      appending to the in-memory `priorResults` array.
- [x] 4.3 Build the per-dispatch `Map<nodeId, NodeResult>` from
      `priorResults` (latest entry per nodeId wins) and pass
      it to the substitution layer.
- [x] 4.4 Tests covering the "Latest iteration wins" scenario
      and the "Missing-required-output override records the
      named reason" scenario.

## 5. SQLite — schema v3 + RunStore methods

- [x] 5.1 Create `src/storage/migrations/0003_add_node_outputs.sql`
      with the `CREATE TABLE node_outputs` statement and the
      `idx_node_outputs_run_node_iter` index (per the
      run-storage delta).
- [x] 5.2 Mirror the migration as an entry in the inline
      `MIGRATIONS` array exported from
      `src/storage/migrations/index.ts` with `version: 3` and
      `name: "add_node_outputs"`.
- [x] 5.3 Add `recordNodeOutputs` and `getNodeOutputs` to the
      `RunStore` interface (and any in-memory stub used by
      tests). Wire `recordNodeOutputs` to be a no-op on an
      empty index.
- [x] 5.4 Implement both methods in the SQLite adapter:
      `INSERT OR REPLACE` for record (idempotent on the PK);
      `SELECT ... ORDER BY node_id, iteration, output_key`
      with the optional filters for get.
- [x] 5.5 Wire `runner/run.ts` to invoke `recordNodeOutputs`
      after the validation pass and before `recordNodeEnd` for
      the same iteration.
- [x] 5.6 Tests in `src/storage/sqlite.test.ts` covering:
      fresh DB applies v3; v2 DB migrates to v3; empty index
      is a no-op; re-record replaces row; getNodeOutputs filters
      and ordering.

## 6. CLI — `runs show --outputs`

- [x] 6.1 In `src/cli/runs.ts` (or wherever `runs show` is
      implemented), add the `--outputs` flag to the
      `runs show` subcommand.
- [x] 6.2 After printing the event log, call
      `store.getNodeOutputs(runId)` and render the tree per the
      "`minifac runs show <id> --outputs` flag" requirement.
      Reuse a `formatBytes` helper for SI-style sizes.
- [x] 6.3 When `--json` is supplied alongside `--outputs`,
      emit the trailing
      `{"type":"outputs","rows":[...]}` NDJSON line instead of
      the human tree.
- [x] 6.4 When `--follow` is supplied alongside `--outputs`,
      defer the outputs section to the end of the tail loop
      (or, for already-terminal runs, the end of buffered
      events).
- [x] 6.5 Tests covering every scenario in the
      "`minifac runs show <id> --outputs` flag" requirement.

## 7. CLI — `runs cat`

- [x] 7.1 Add a new `runs cat <id> <selector>` subcommand to
      `src/cli/runs.ts` (or `src/cli.ts` if subcommands are
      registered there).
- [x] 7.2 Parse the selector grammar:
      `<node-id>[:<iteration>]/<output-key>[/<filename>]`.
      Reject malformed selectors with a usage error.
- [x] 7.3 Resolve `<id>` via the existing run-id resolver
      (full id or unambiguous prefix). Look up the output via
      `store.getNodeOutputs(runId, { nodeId, iteration })`.
- [x] 7.4 Dispatch by output type:
  - `value` / `file` → print raw file contents (no
    pretty-printing).
  - `directory` without trailing filename → print the
    directory's path and a recursive file listing with sizes.
  - `directory` with trailing filename → resolve the file
    inside the directory, reject `..` traversal, print raw
    contents.
- [x] 7.5 Exit-code contract per the requirement: `0` on
    success; `1` on usage error, unknown id/node/key/iteration,
    missing-on-disk-file, or fatal I/O.
- [x] 7.6 Tests covering every scenario in the
      "`minifac runs cat <id> <selector>` subcommand"
      requirement.

## 8. CLI — `prune --outputs`

- [x] 8.1 Add the `--outputs` flag to the `prune` subcommand in
      `src/cli.ts`. Default off; purely additive.
- [x] 8.2 In `src/worktree/prune.ts` (or a sibling
      `src/outputs/prune.ts` if cohesion suggests a new file),
      extract a shared classification helper if the worktree
      classifier isn't already shareable.
- [x] 8.3 When `--outputs` is supplied, walk
      `${MINIFAC_HOME}/outputs/<run-id>/`, look up each
      `<run-id>` in `runs.db`, classify by status + mtime,
      apply the same flag matrix used for worktrees, `rm -rf`
      the selected directories, and DELETE matching rows from
      `node_outputs` for each removed `run_id`.
- [x] 8.4 Update the summary line to report
      removed-per-bucket counts for outputs in addition to
      worktrees.
- [x] 8.5 Tests covering every scenario added to the
      "`minifac prune` subcommand" requirement.

## 9. Documentation

- [x] 9.1 Extend `docs/concepts/Factory.md`'s `## Schema`
      section to include the new `outputs:` block in the node
      fields table at the same depth `with:` is documented.
- [x] 9.2 Create `docs/concepts/Outputs.md` covering: what
      outputs are; the three types; storage layout
      (`~/.minifac/outputs/<run-id>/<node-id>/<iteration>/`);
      template access syntax (path-by-default + `:read`
      suffix); the validation contract (required outputs,
      sentinel-failed skip, `missing_required_output`); the
      `runs show --outputs`, `runs cat`, and `prune --outputs`
      operator surfaces. Use Obsidian-style `[[wikilinks]]`
      to cross-reference [[Factory]], [[Run]], [[Runs-DB]].
- [x] 9.3 Add backlinks to `Outputs.md` from `Factory.md`,
      `Run.md`, and `Runs-DB.md`.
- [x] 9.4 Mention `docs/decisions/0027-Node-Outputs.md` in
      `Outputs.md`'s prose as the binding architectural
      decision.

## 10. Integration check

- [x] 10.1 Verify the existing `examples/hello.yaml` and
      `examples/sdd.yaml` still load and run unchanged (they
      declare no `outputs:`; the new code path SHALL be a no-op
      for them beyond creating the outputs directory).
- [x] 10.2 Add an integration test that defines a tiny two-node
      factory (`writer → reader`) where `writer` declares a
      required `value` output and `reader` consumes it via
      `{{ priorResults.writer.outputs.findings:read }}`. Assert
      the substituted prompt the executor sees.
- [x] 10.3 Add an integration test where the writer node
      succeeds but does NOT write the required output;
      assert the runner overrides to `failed` with reason
      `missing_required_output` and that the downstream
      `reader` node is NOT scheduled (no `on_failure` edge).
- [x] 10.4 Run the full test suite (`npm test` or whatever
      verify the repo uses) and confirm all existing tests
      still pass.
