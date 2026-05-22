---
tags: [concept]
aliases: [outputs, node-outputs]
---

# Outputs

Outputs are a node's declared, typed deliverables — the structured
results downstream nodes consume via the [[Factory]] template surface
and operators inspect via the [[Runs-DB]] CLI. Each node MAY declare an
`outputs:` block on its definition; the [[Runner]] validates declared
outputs post-execution, indexes them in [[Runs-DB]], and exposes
contents at a deterministic on-disk location.

The binding architectural decision is `docs/decisions/0027-Node-Outputs.md`.
This concept note covers the v1 (filesystem-JSON) shape.

## Three output types

- **`type: "value"`** — a JSON-encoded value. The model reports it
  via the per-run MCP transport (`mcp__minifac__report_<key>(value)`)
  when the dispatching executor speaks MCP; the runner's bridge writes
  `<outputs_dir>/<key>.json` atomically. The filesystem-JSON fallback
  is still honored — if the model writes `<outputs_dir>/<key>.json`
  directly with its `Write` tool, the validator picks it up unchanged.
  See [[Decisions/0029-Node-Outputs-MCP]] for the dual-transport
  rationale. A `required` value that's missing or unparseable fails
  the node.
- **`type: "file"`** — a file in the outputs directory. With
  `filename: "patch.diff"` the runner looks at exactly that path.
  Without `filename:`, it globs `<outputs_dir>/<key>.*` and requires
  exactly one match (ambiguity counts as missing).
- **`type: "directory"`** — a directory at `<outputs_dir>/<key>/`.
  Required directories must be non-empty (≥1 file at any depth).

Every output type accepts `required: boolean` (default `false`) and
`description: string` (optional). The `value` type also accepts a
`shape:` field reserved for future structural typing — schema-accepted
but ignored by the v1 validator.

Output keys match the same identifier grammar as step input keys
(`^[a-zA-Z_][a-zA-Z0-9_]*$`).

## Storage layout

Outputs live outside the [[Worktree]], scoped to the [[Run]]:

```
${MINIFAC_HOME}/outputs/<run-id>/<node-id>/<iteration>/
```

The runner mkdirs this path before dispatching the node, so the
executor can write to it without race. Every iteration gets its own
directory; the iteration-1 directory is never overwritten when
iteration 2 starts.

## Template access from downstream nodes

Two reserved tokens land in this change:

- `{{ run.outputs_dir }}` — the absolute path of the current node's
  per-iteration outputs directory. Used in `with.prompt` to tell the
  model where to write its findings, or in `cwd` to chdir there.
- `{{ priorResults.<node-id>.outputs.<key> }}` — the absolute path of
  the named output produced by the latest iteration of `<node-id>` in
  this run. Use this when you want the downstream node to receive a
  path that it can hand to a tool (`cat <path>`, `git apply <path>`).
- `{{ priorResults.<node-id>.outputs.<key>:read }}` — the file
  contents, inlined into the prompt. Capped at 64 KB; oversize files
  throw a `TemplateSubstitutionError` naming the key, the actual size,
  and the cap. Directory outputs cannot be `:read` (also throws).

Missing prior results, missing keys, or `null`-outputs entries
substitute the empty string (same convention as missing-optional
brief / inputs fields).

## Post-execution validation

After the executor's event stream drains and the terminal status
resolves, the runner runs the validator. It only runs when the node:

- Declared an `outputs:` block, AND
- Terminated `succeeded` (sentinel or non-zero exit failures skip
  validation entirely).

The validator scans each declared output, builds the `NodeOutputIndex`
of present-and-satisfied entries, and computes the missing-required
set. If that set is non-empty, the validator **overrides** the node's
terminal status from `succeeded` to `failed` with reason
`missing_required_output`. The override fires loudly: stderr names the
missing keys and the directory the runner expected to find them in,
and the status event's `meta` carries `missing_outputs`,
`missing_outputs_detail`, and `partial_index`.

Sentinel-failed nodes (e.g. `verify` reporting "3 tests failed") and
non-zero-exit nodes never get the missing-output override —
operators see the actual failure reason, not a misleading
"missing_required_output."

## Operator surfaces

- `minifac runs show <id> --outputs` — prints a tree after the event
  log:

  ```
  Outputs for run <id>:
    propose (iter 1):
      findings (value, 412 B)
    verify (iter 2):
      logs (directory, 4 files, 22.5 KB)
  ```

  With `--json`, emits a trailing
  `{"type":"outputs","rows":[<NodeOutputRow>, ...]}` line after the
  per-event NDJSON.

- `minifac runs cat <id> <selector>` — prints one output's contents.
  Selector grammar:
  `<node-id>[:<iteration>]/<output-key>[/<filename>]`. Default
  iteration is the latest. For `directory` outputs without a trailing
  filename, prints the directory's absolute path followed by a
  recursive file listing with sizes; with a trailing filename, prints
  the contained file's raw contents (rejecting `..` traversal).

- `minifac prune --outputs [--older-than <duration>] [--all]
  [--failed]` — reclaims per-run output directories using the same
  hybrid policy as worktree pruning. Running runs are never eligible.

## Dual transport for `value` outputs

`value` outputs land via one of two paths, both converging on the
same `<outputs_dir>/<key>.json` file:

1. **MCP transport (preferred, default for Claude).** The runner
   starts a per-run inline MCP server on a unix socket sibling to
   the per-run outputs tree (see [[Config]]). For each dispatching
   node, it registers one MCP tool per declared `type: "value"`
   output: `mcp__minifac__report_<key>(value: <derived schema>)`.
   When the model calls the tool, the runner's bridge validates the
   payload, serializes deterministically (sorted keys, 2-space
   indent), and writes the file atomically (`.tmp-*` sibling +
   `rename`). Tool calls are visible as `tool_use` events in the
   stream-json log, so the TUI / web viewer see "outputs reported"
   in the timeline.
2. **Filesystem-JSON fallback.** Executors with
   `supportsMcp: false`, or any model that prefers its own `Write`
   tool, can land `<outputs_dir>/<key>.json` directly. The validator
   reads from disk regardless of transport.

`file` and `directory` outputs are filesystem-only — MCP doesn't
help when the natural shape is a file. The model writes them with
its existing tools; the validator detects them on disk after
termination.

Binding decision: `docs/decisions/0029-Node-Outputs-MCP.md`.

## v1 trade-offs

- The `:read` cap is 64 KB. Oversize throws rather than truncates so
  the failure is loud.
- `prune --outputs` does not yet sweep outputs lazily at run start;
  explicit invocations are the v1 reclaim path.
- Per-iteration template selection (`priorResults.X:1.outputs.Y`) is
  not in v1 — latest iteration only.

Cross-references: [[Factory]] (the `outputs:` schema slot), [[Run]]
(the run-id namespacing), [[Runs-DB]] (the `node_outputs` table and
the index lifecycle), [[Worktree]] (where outputs do **not** live —
they're separate, run-scoped, persistent across worktree pruning).
