---
change: node-outputs
factory: sdd
base_branch: main
---

## Background

Today, downstream nodes have no first-class way to consume
structured data produced by upstream nodes. The `priorResults`
array carries status metadata only (see `extractReason` at
`src/runner/run.ts:419`). Any factory shape that needs typed
findings to flow between stages — code review, multi-step
analysis, anything fan-in-shaped — is currently blocked.

The binding decision is at
`docs/decisions/0027-Node-Outputs.md`. Read it first. Key
calls already locked:

- Per-node `outputs:` declaration in factory schema, with
  three types: `value` (JSON), `file`, `directory`.
- Outputs live at `~/.minifac/outputs/<run-id>/<node-id>/<iteration>/`
  — outside the worktree, run-scoped, full history preserved.
- v1 transport for `value` outputs is **filesystem JSON
  files** (the model writes `<outputs_dir>/<key>.json`). The
  MCP transport upgrade is a separate brief
  (`node-outputs-mcp`).
- No nudge logic in this brief — that's the
  `node-outputs-nudge` brief. v1 fails the node immediately
  on missing required outputs.
- Required-output validation only fires on
  sentinel-succeeded nodes; sentinel-failed nodes skip the
  check.

## What to do

### 1. Schema — `outputs:` on factory nodes

Extend `src/factory/schema.ts`:

```typescript
const OutputValueSchema = z.object({
  type: z.literal("value"),
  required: z.boolean().optional().default(false),
  description: z.string().optional(),
  // Future: `shape: z.object(...)` for structural typing
});
const OutputFileSchema = z.object({
  type: z.literal("file"),
  filename: z.string().min(1).optional(),
  required: z.boolean().optional().default(false),
  description: z.string().optional(),
});
const OutputDirectorySchema = z.object({
  type: z.literal("directory"),
  required: z.boolean().optional().default(false),
  description: z.string().optional(),
});
const OutputDefSchema = z.discriminatedUnion("type", [
  OutputValueSchema, OutputFileSchema, OutputDirectorySchema,
]);

// On NodeSchema:
outputs: z.record(z.string(), OutputDefSchema).optional(),
```

Each output key must match `[a-zA-Z_][a-zA-Z0-9_]*` (same
as input keys).

### 2. Outputs directory + `{{ run.outputs_dir }}` token

In the runner (`src/runner/run.ts`), per-node-per-iteration:

- Compute `outputs_dir = ${MINIFAC_HOME}/outputs/${runId}/${nodeId}/${iteration}/`.
- Create the directory before node dispatch (mkdirp).
- Expose it as a new substitution token. Extend
  `Substitutions` in `src/runner/substitute.ts`:
  ```typescript
  run?: { cwd: string; outputs_dir?: string };
  ```
- Update the substitute regex to include the new token.
- Pass `outputs_dir` through `RunContext` to every executor.

### 3. Production — model writes outputs to disk

No engine change for production. The factory author writes
prompts that tell the model:

> When you're done, write your findings as JSON to
> `{{ run.outputs_dir }}/findings.json`. Write your report
> to `{{ run.outputs_dir }}/report.md`.

The model uses its existing Write tool. The runner doesn't
inject output-emission instructions in v1.

### 4. Validation — post-execution check

In `src/runner/run.ts`, after the executor terminates but
before recording the `NodeResult`:

```typescript
async function validateDeclaredOutputs(
  node: ResolvedNode,
  outputsDir: string,
  finalStatus: "succeeded" | "failed",
): Promise<ValidationResult> {
  if (finalStatus !== "succeeded") return { ok: true, missing: [], index: {} };
  if (!node.outputs) return { ok: true, missing: [], index: {} };

  const missing: string[] = [];
  const index: NodeOutputIndex = {};

  for (const [key, def] of Object.entries(node.outputs)) {
    if (def.type === "value") {
      const path = `${outputsDir}/${key}.json`;
      // Check exists, parse, validate against declared type
      // (loose: string/number/boolean → typeof; array/object → structural)
      // ...
    } else if (def.type === "file") {
      const filename = def.filename ?? // first file in outputs_dir matching <key>.* ?
      // Check existence
      // ...
    } else if (def.type === "directory") {
      // Check directory exists and has ≥1 file
      // ...
    }

    if (def.required && !found) missing.push(key);
  }

  return { ok: missing.length === 0, missing, index };
}
```

If `ok === false`, override the node's terminal status to
`failed` with reason `missing_required_output` and
`meta.missing_outputs = missing`.

### 5. Persistence

Extend `NodeResult` in `src/executor/types.ts`:

```typescript
outputs: NodeOutputIndex | null;
```

Where `NodeOutputIndex` is a map of key → `{ type, path,
size, mtime }`. Don't store contents in the result struct.

Add a `node_outputs` table to the runs.db migration system:

```sql
CREATE TABLE node_outputs (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  output_key TEXT NOT NULL,
  output_type TEXT NOT NULL,    -- "value" | "file" | "directory"
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id, iteration, output_key)
);
```

The runner inserts a row per output produced; contents stay
on disk.

### 6. Consumption — template substitution

Extend `Substitutions` and the substitute regex:

```typescript
priorResults?: ReadonlyMap<string, NodeResult>;  // keyed by nodeId; latest iteration only
```

Token grammar:

- `{{ priorResults.<node-id>.outputs.<key> }}` →
  absolute filesystem path (string)
- `{{ priorResults.<node-id>.outputs.<key>:read }}` →
  inline contents (capped at 64 KB by default; throw
  if larger and `:read` was requested)

The runner builds the `priorResults` map at the start of each
node's dispatch (latest iteration per node id), threads it
through, and runs substitution.

### 7. CLI

`src/cli.ts` / `src/cli/runs.ts`:

- `minifac runs show <id> --outputs` — extends the existing
  `show` to list outputs alongside events. Tree view:
  ```
  Outputs for run abc123...:
    propose (iter 1):
      summary.json (value, 412 B)
    apply (iter 1):
      patch.md (file, 18.2 KB)
    verify (iter 1):
      results.json (value, 1.1 KB)
      logs/ (directory, 4 files, 22.5 KB)
  ```
- `minifac runs cat <id> <node-id>/<key>` — print one
  output's contents. Defaults to latest iteration; pass
  `<node-id>:N/<key>` for a specific iteration. For
  directories, prints the file list (or the contents if a
  specific file is named: `<node-id>/<key>/<filename>`).

### 8. Prune — output cleanup

`src/worktree/prune.ts` (and the CLI's `prune` command) gain
an `--outputs` flag:

- `minifac prune --outputs [--older-than <duration>]` —
  removes output directories per the same hybrid policy used
  for worktrees. Sources of truth: `runs.db` for run status
  (succeeded / failed / running), filesystem `mtime` for
  age.

Default behavior with no flags: prune unchanged (worktree-
focused). The `--outputs` flag opts into output cleanup.

### 9. Concept doc updates

Extend `docs/concepts/Factory.md`'s `## Schema` section
(added in `3e527a6`) to include the new `outputs:` block in
the node fields table. Mirror the depth used for
`with:` fields.

Add a new concept doc `docs/concepts/Outputs.md` covering:

- What outputs are
- The three types
- Storage layout
- Template access syntax
- The validation contract

Cross-link from [[Factory]], [[Run]], [[Runs-DB]].

### 10. Tests

Cover at least:

- Factory schema accepts well-formed `outputs:` declarations
  for all three types; rejects malformed ones.
- Runner creates `outputs_dir` before node dispatch.
- `{{ run.outputs_dir }}` substitution works.
- Required `value` output missing → node fails with
  `missing_required_output` and meta carries the missing key.
- Required `file` output missing → same.
- Required `directory` output missing or empty → same.
- Optional outputs missing → node succeeds with `outputs`
  null for that key.
- Failed sentinel skips the outputs check entirely.
- `priorResults.<node-id>.outputs.<key>` substitution
  resolves to absolute path.
- `:read` suffix returns file contents; throws on >64 KB.
- runs.db gains a row per produced output; structure matches
  the migration.
- `runs show --outputs` lists produced outputs.
- `runs cat` prints contents.

### 11. Spec deltas

- `factory-schema`: ADD a requirement for the `outputs:`
  block on nodes; MODIFY existing node-shape requirements
  to mention the new field (copy the entire block when
  modifying).
- `graph-runner`: ADD a requirement for post-execution
  output validation and the `missing_required_output`
  failure reason.
- NEW capability `node-outputs` (or fold into `graph-runner`
  — your judgment) covering storage layout, template
  access, and the validation contract.

## Out of scope

- The MCP transport upgrade — see
  `node-outputs-mcp` brief (depends on this one).
- The output-missing nudge / recovery loop — see
  `node-outputs-nudge` brief (depends on this one).
- Per-iteration template syntax (`{{ priorResults.X:1.outputs.Y }}`).
- Output content stored in `runs.db`.
- Structural typing for `value` outputs beyond `string` /
  `number` / `boolean` / `array` / `object`.

## Acceptance criteria

- Factory schema validates `outputs:` declarations
- Runner creates `{{ run.outputs_dir }}` before each node
  dispatch
- Required outputs missing → node fails with
  `missing_required_output`
- Optional outputs missing → no failure
- Failed-sentinel nodes skip the outputs check
- `NodeResult.outputs` populated and persisted
- `runs.db` carries the new `node_outputs` table
- Template substitution resolves `{{ priorResults.<id>.outputs.<key> }}`
- `minifac runs show --outputs` and `minifac runs cat`
  work end-to-end
- `minifac prune --outputs` reclaims disk
- `docs/concepts/Outputs.md` exists; Factory.md schema
  updated
- All existing tests pass; new tests cover the criteria
  above
