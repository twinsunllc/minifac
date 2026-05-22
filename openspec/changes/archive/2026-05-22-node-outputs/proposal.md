## Why

Downstream nodes have no first-class way to consume structured data
produced by upstream nodes. The `priorResults` array carries terminal
status and a sentinel reason string only; it doesn't surface
typed findings, generated files, or directory artifacts. Any
factory shape that needs typed output to flow between stages —
code review handing structured findings to a fix node, a
multi-step analyzer fanning in to a summary, a plan/apply split
that shares a patch file — is blocked today.

The binding architectural decision is recorded in
`docs/decisions/0027-Node-Outputs.md`. This change implements the
filesystem-JSON v1 of that decision: per-node `outputs:`
declarations, run-scoped `~/.minifac/outputs/<run-id>/<node-id>/<iteration>/`
directories, post-execution required-output validation, persistence
to `runs.db`, and template-based consumption from downstream nodes
via the existing `priorResults` substitution surface.

## What Changes

- **NEW** `outputs:` block on factory nodes — three discriminated
  output types (`value` for JSON, `file`, `directory`), each with
  optional `required` and `description` fields, plus a
  `value`-type-only `shape` reservation for future structural
  typing. Each output key matches the same identifier regex used
  for step input keys.
- **NEW** `{{ run.outputs_dir }}` template token, available in
  node `with.prompt` and `cwd` strings, resolving to the
  per-node-per-iteration outputs directory absolute path. The
  runner SHALL create this directory before dispatch (mkdirp,
  recursive) so the executor can write to it without race.
- **NEW** post-execution validation: after the executor terminates
  and before recording the `NodeResult`, the runner SHALL scan the
  declared outputs against the on-disk outputs_dir, parse `value`
  outputs as JSON, check `file` outputs by filename (or
  `<key>.<ext>` discovery when `filename:` is omitted), check
  `directory` outputs are non-empty, and on missing required
  outputs override the node's terminal status to `failed` with
  reason `missing_required_output` and a `meta.missing_outputs`
  array. Validation SHALL skip entirely when the node terminated
  `failed` for any other reason (sentinel-failed nodes do not also
  fail on outputs).
- **NEW** `NodeResult.outputs` field carrying an index map of
  produced output keys to `{ type, path, size, mtime }` records.
  Contents stay on disk; the index sits on the result struct.
- **NEW** `node_outputs` SQLite table — one row per produced
  output per node iteration, keyed by
  `(run_id, node_id, iteration, output_key)`, projecting the
  index map fields plus `output_type`. Shipped as migration
  `0003_add_node_outputs.sql`.
- **NEW** `{{ priorResults.<node-id>.outputs.<key> }}` substitution
  token, resolving to the absolute filesystem path of the produced
  output (string). A `:read` suffix
  (`{{ priorResults.<node-id>.outputs.<key>:read }}`) inlines the
  file's contents with a 64 KB cap; oversize SHALL throw a
  substitution error naming the key and size. Latest iteration of
  each node id wins; per-iteration syntax is out of scope.
- **NEW** `minifac runs show <id> --outputs` flag — extends the
  existing `runs show` subcommand to print a tree of produced
  outputs per node per iteration with type, size, and (for
  directories) file count.
- **NEW** `minifac runs cat <id> <node-id>/<key>` subcommand —
  prints one output's contents to stdout. Defaults to the latest
  iteration; `<node-id>:N/<key>` selects iteration `N`. For
  directory outputs, lists the contained files; for
  `<node-id>/<key>/<filename>` against a directory, prints that
  contained file.
- **NEW** `minifac prune --outputs [--older-than <duration>]` flag —
  reclaims per-run output directories using the same hybrid
  classification policy already used for worktrees, sourced from
  `runs.db` for run status and the filesystem `mtime` for age.
- **NEW** concept doc `docs/concepts/Outputs.md` covering output
  types, storage layout, template-access syntax, and the
  validation contract; cross-linked from existing
  [[Factory]], [[Run]], [[Runs-DB]] concept notes; Factory.md's
  Schema section grows an `outputs:` row mirroring the depth
  used for `with:`.

## Capabilities

### New Capabilities

(none — this change extends existing capabilities; introducing a
new `node-outputs` capability for a feature this tightly woven
into factory schema + graph runner + run storage + CLI would
fragment the spec without separating any new component boundary.)

### Modified Capabilities

- `factory-schema`: ADD a requirement for the `outputs:` block on
  node definitions and the discriminated output types; MODIFY the
  existing "Node definition" requirement to mention the new
  field in the accepted node-level key set (copying the entire
  requirement per delta rules); MODIFY the existing "Reserved
  brief template tokens in node prompts" requirement to reserve
  `run.outputs_dir` alongside `run.cwd`.
- `graph-runner`: ADD requirements for (a) per-node-per-iteration
  outputs directory creation, (b) post-execution outputs
  validation and the `missing_required_output` reason, (c)
  `NodeResult.outputs` population; MODIFY the existing
  "Brief token substitution before node dispatch" requirement to
  add `run.outputs_dir` and `priorResults.<id>.outputs.<key>[:read]`
  to the resolved namespaces; MODIFY the existing "Prior-results
  accumulate" requirement to add the `outputs` field shape.
- `run-storage`: ADD a requirement for schema v3 introducing the
  `node_outputs` table and the matching `RunStore` methods
  (`recordNodeOutputs`, `getNodeOutputs`).
- `run-cli`: ADD requirements for `minifac runs show --outputs`
  display and the new `minifac runs cat` subcommand; MODIFY
  the existing "`minifac prune` subcommand" requirement to
  document the `--outputs` flag.

## Impact

- `src/factory/schema.ts` — discriminated union for output defs;
  `outputs?: Record<string, OutputDef>` on the node shape; key
  identifier validation matching input keys; strict-on-extras
  preserved at node level (the accepted key set in the existing
  spec grows by one).
- `src/runner/run.ts` — outputs_dir computation and mkdirp before
  dispatch; post-execution validation pass; failure-override path;
  `NodeResult.outputs` population; store hook for persisting the
  index.
- `src/runner/substitute.ts` — extend `Substitutions` with
  `run.outputs_dir`, `priorResults` (latest iteration map per
  node id), and the `:read` suffix grammar; per-substitution
  64 KB cap throw on oversize `:read`.
- `src/executor/types.ts` — `NodeResult.outputs:
  NodeOutputIndex | null` and the `NodeOutputIndex` type.
- `src/storage/migrations/0003_add_node_outputs.sql` (new) +
  mirrored entry in `src/storage/migrations/index.ts`.
- `src/storage/sqlite.ts` — implement the new `RunStore`
  methods; insert one row per produced output as part of
  `recordNodeEnd` (or a new `recordNodeOutputs` call paired
  with it).
- `src/cli.ts` / `src/cli/runs.ts` — `--outputs` flag on
  `runs show`; new `runs cat` subcommand with its own
  argument parsing.
- `src/worktree/prune.ts` — extract the existing classification
  policy if not already shared; reuse against output directories;
  add the `--outputs` flag wiring.
- `examples/` — no example factory changes required for the
  v1 surface to be testable, but the SDD example MAY grow
  an `outputs:` block on its `propose` node in a follow-on
  change once the MCP transport upgrade lands.
- Tests alongside each module per the project convention.

### Out of scope

- The MCP transport upgrade for `value` outputs — separate brief
  `node-outputs-mcp` (depends on this one).
- The output-missing nudge / recovery loop — separate brief
  `node-outputs-nudge` (depends on this one).
- Per-iteration template syntax
  (`{{ priorResults.X:1.outputs.Y }}`) — explicitly deferred; v1
  latest-iteration only.
- Storing output contents in `runs.db` — contents live on disk;
  the index lives in the DB.
- Structural typing for `value` outputs beyond JavaScript-typeof
  matching — the `shape:` reservation is schema-accepted but the
  validator is a follow-on.
- Garbage-collecting outputs in the lazy-prune pass at
  `minifac run` start — `--outputs` is an explicit pass for v1;
  lazy outputs cleanup follows the same future work that
  generalizes the worktree lazy prune.
