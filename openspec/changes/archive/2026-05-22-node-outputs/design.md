## Context

`docs/decisions/0027-Node-Outputs.md` recorded the binding choices
for how minifac nodes produce and consume structured data:

- Outputs are declared per-node in the factory schema (`outputs:`).
- Three types ship: `value` (JSON), `file`, `directory`.
- Outputs live at `~/.minifac/outputs/<run-id>/<node-id>/<iteration>/`
  — outside the worktree, run-scoped, full per-iteration history.
- The v1 transport for `value` outputs is **filesystem JSON files**
  — the model writes `<outputs_dir>/<key>.json` using its existing
  Write tool. The MCP transport is a separate proposal.
- The runner declares `outputs_dir` as a substitution token; it
  doesn't otherwise instruct the model on output-emission.
- Missing required outputs fail the node post-hoc. Sentinel-failed
  nodes don't double-fail on outputs.

This change is the first cut of the contract. It pulls in
factory-schema (the declaration grammar), graph-runner (creation,
validation, substitution), run-storage (the persistence layer),
and run-cli (the surfaces an operator uses to inspect and reclaim
outputs). Splitting these into four parallel changes would
fragment the contract because they share types
(`OutputDef`, `NodeOutputIndex`) and depend on each other for any
behavior to be observable.

## Goals / Non-Goals

**Goals:**

- Author surface: a single, predictable `outputs:` block on each
  node. Three discriminated types. Identifier grammar matches
  step input keys so authors don't have to learn two rules.
- Runtime surface: one filesystem location per node iteration,
  surfaced through one substitution token. Outputs that don't
  exist on disk after the node finishes are a fail-fast condition,
  not a silent miss.
- Inspection surface: `runs show --outputs` for an overview and
  `runs cat` for one file's contents. No new daemon endpoints,
  no new CLI tree.
- Lifecycle surface: `prune --outputs` reclaims disk the same way
  `prune` reclaims worktrees, against the same hybrid policy. No
  new garbage-collection daemon.
- Persistence: an index in `runs.db` so future tooling can
  enumerate outputs without a directory walk; contents stay on
  disk because that's where the model wrote them.

**Non-Goals:**

- The MCP transport upgrade for `value` outputs. The author
  surface (`outputs.value`) is forward-compatible; the runtime
  transport is the only piece that changes. Separate brief.
- Output-missing recovery / nudge loops. v1 fails the node
  immediately; a future brief layers a retry loop on top.
- Structural typing beyond JS typeof. `OutputValueSchema` reserves
  a `shape` slot but the validator doesn't enforce it yet.
- Per-iteration template syntax. Latest-iteration only in v1.
- Storing output contents in `runs.db`. Index only.
- Output emission instructions injected by the runner. The
  factory author writes prompts; the runner only creates the
  directory and validates after.

## Decisions

### D1. One filesystem location per node per iteration

Outputs live at `${MINIFAC_HOME}/outputs/<run-id>/<node-id>/<iteration>/`.

Alternatives considered:

- **Per-run dir, all nodes flat:** ambiguous when multiple nodes
  produce the same key; loses iteration history.
- **Inside the worktree:** outputs from later iterations would
  pollute the worktree the executor is working in; pruning
  worktrees would also delete still-useful outputs.
- **Per-node-id only (no iteration dir):** loses history across
  iterations of a cycle, which kills the SDD verify→propose
  feedback loop's ability to compare runs.

The run-scoped, node-scoped, iteration-scoped tree is the only
shape that survives every cycle pattern minifac supports.

### D2. Filesystem-JSON transport for `value` outputs in v1

The model writes `<outputs_dir>/<key>.json` using its existing
Write tool. The runner doesn't inject MCP, doesn't intercept
emit calls, doesn't proxy stdout.

Rationale:

- Zero new infrastructure. Every executor that can write a file
  can produce a `value` output.
- Forward-compatible with the MCP upgrade — when MCP lands, the
  runner intercepts an `emit` tool call and writes the same
  `<key>.json`. The on-disk contract doesn't change.
- The runner's validation pass parses JSON files; it doesn't need
  to know how they got there.

Trade-off accepted: the model can write a non-JSON `<key>.json`
file and the validation pass fails with a parse error rather than
a clean "value output is malformed" message. That's acceptable
for v1 because the same model is reading the failure reason from
the next node's `priorResults` anyway.

### D3. Post-execution validation, not in-band

The runner validates declared outputs after the executor's event
stream drains and the terminal status is resolved, not during
execution. This means a successful sentinel can be overridden to
`failed` with reason `missing_required_output` if the model
forgot to write a required output.

Alternatives considered:

- **In-band schema:** intercept tool calls, fail mid-execution on
  missing outputs at completion. Requires deep executor
  integration; doesn't generalize across runners.
- **Author-side validation in the next node:** wait for the
  downstream consumer to fail when it can't read the file. Defers
  the error too far from its source; the operator sees "verify
  failed" instead of "propose didn't write findings.json".

Post-hoc validation is the minimum viable shape that fails fast
without coupling the runner to any executor's internals.

### D4. Failed-sentinel nodes skip outputs validation

If the node terminated `failed` for any reason other than
`missing_required_output` itself, the validation pass is skipped.

Rationale: a sentinel-failed node likely didn't produce outputs
(that's why it failed), and overriding its reason with
`missing_required_output` would lose the actual failure signal.
The operator wants to see "verify hit error: 3 tests failed", not
"verify failed: missing required output `report.md`".

### D5. `NodeResult.outputs` is an index, contents stay on disk

`NodeResult.outputs: NodeOutputIndex | null` where
`NodeOutputIndex = Record<string, { type, path, size, mtime }>`.

Alternatives considered:

- **Contents in the struct:** unbounded blob storage in memory
  for every run with outputs. Kills large-file outputs
  (`directory` of generated images, multi-megabyte `report.md`).
- **Path-only index:** loses the metadata that `runs show
  --outputs` and any future TUI need; would force a stat call
  per output on every read.

`size` and `mtime` are cheap at write time (the runner just
stat'd the file to validate it) and saving them eliminates a
per-render stat from every downstream consumer.

### D6. `runs.db` schema v3 introduces `node_outputs`

```sql
CREATE TABLE node_outputs (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  output_key TEXT NOT NULL,
  output_type TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id, iteration, output_key)
);
```

Index on `(run_id, node_id, iteration)` for the common "show me
this node iteration's outputs" lookup. No index on `output_key`
alone — global queries by key don't show up in any of the v1
surfaces.

Migration is additive (CREATE TABLE only). The existing v1+v2
schema is unaffected; old runs continue to load with an empty
outputs index.

### D7. `priorResults.<id>.outputs.<key>` template grammar

Resolves to the absolute path of the produced output (a string).
The `:read` suffix inlines file contents with a 64 KB cap;
oversize throws with a substitution error naming the key.

Why path-by-default:

- `file` and `directory` outputs almost always need to be passed
  to a tool by path (`grep <path>`, `cat <path>`, `git apply
  <path>`); inlining them in the prompt is rarely what the
  author wants.
- `value` outputs can be inlined with `:read` when small, or
  read by the executor's tools when large.
- A consistent default rule across all three output types beats
  per-type implicit behavior.

The 64 KB cap is large enough to inline typical structured
findings JSON (a few hundred review items) and small enough to
keep a typo from accidentally inlining a binary blob into a
prompt. Throwing (vs. truncating) on oversize keeps the failure
loud — the author sees the cap and either widens it (future
flag) or removes the `:read`.

Latest iteration only — per-iteration syntax is deferred. The
substitution builds a `Map<nodeId, NodeResult>` keyed by node id
with the latest entry winning, so the lookup is O(1) per token.

### D8. CLI surfaces stay narrow

- `runs show --outputs` extends an existing subcommand.
- `runs cat <id> <node-id>/<key>` is one new subcommand.
- `prune --outputs` is one new flag on an existing subcommand.

Alternatives considered:

- **`minifac outputs` top-level command:** would need `list`,
  `show`, `cat`, `prune` subcommands and a UX that mirrors
  `runs`. The outputs lifecycle is so tightly bound to a run
  that operators reach for `runs <id>` first; folding outputs
  there fits muscle memory.
- **HTTP / daemon surface:** the serve daemon already exposes
  per-run data; outputs surface through that the same way events
  do (via the store), no new endpoint needed for v1.

## Risks / Trade-offs

- [Operator confusion when a successful sentinel turns into
  `missing_required_output`] → The validation error message
  SHALL name both the missing keys and the directory path the
  runner expected to find them in, so the operator can immediately
  inspect what the model actually wrote and adjust the prompt.

- [Outputs directory grows unbounded] → `minifac prune --outputs`
  ships in the same change. Lazy-prune at `minifac run` start
  does NOT yet sweep outputs (an explicit pass is required); a
  future change can lift this once we have data on disk-pressure
  patterns.

- [Author writes a non-JSON file to `<key>.json`] → The validator
  fails the node with a clear "value output X failed to parse as
  JSON" reason naming the path. Downstream node sees the failure
  in `priorResults[].reason`.

- [`:read` cap traps an author who needs slightly more than 64 KB]
  → Documented in the new `Outputs.md` concept doc and the
  template substitution spec. Widening the cap is a one-line
  change behind a future per-token suffix
  (`:read(<bytes>)`) that this change does NOT ship.

- [Filename-less `file` outputs ambiguous on multiple matches] →
  When `filename:` is omitted, discovery looks for
  `<outputs_dir>/<key>.*`. If multiple matches exist, the
  validator fails with a clear "ambiguous file output X
  matched N files" reason. Authors who care about exact
  filenames declare `filename:` explicitly.

- [Old runs in `runs.db` predate `node_outputs`] → The store's
  `getNodeOutputs(runId, ...)` returns an empty index for runs
  that pre-date v3. CLI surfaces print "no outputs recorded"
  rather than erroring.

- [Two nodes in a cycle both write to the same outputs key] →
  Each iteration gets its own directory, so iteration 1 and
  iteration 2 of the same node never collide. Two distinct nodes
  can't collide either because the path includes the node id.

## Migration Plan

This is a forward-only schema addition; no data migration is
required. The migration framework already in place applies
`0003_add_node_outputs.sql` on first open of a v2 database.

Existing factories with no `outputs:` block continue to work
unchanged. The runner still creates the per-iteration outputs
directory for every node (even those with no declared outputs),
because (a) it's cheap (one mkdirp per dispatch) and (b) the
`{{ run.outputs_dir }}` token is available to authors who want
to write ad-hoc artifacts without formally declaring them.
Undeclared files in the outputs directory are not validated, not
indexed, and not surfaced — they're "there if the operator
wants to grep for them" only.

Rollback: drop the `node_outputs` table and revert to schema v2.
The substitution token and the validation pass are runtime-only
behaviors; reverting code reverts behavior.

## Open Questions

- Should `--older-than` on `prune --outputs` use `mtime` of the
  iteration directory itself or the latest file `mtime` inside?
  Currently the design uses directory `mtime` for consistency
  with how worktrees are aged. The risk is a long-running node
  whose outputs directory was created early but whose final file
  was written late — `--older-than 1h` could nuke an output that
  was actively written into 5 minutes ago. The mitigation:
  outputs only get classified `failed` / `succeeded` after the
  run finalizes, and `running` runs are never eligible for
  pruning regardless of age, so the worst case is bounded.

- The `shape:` reservation on `OutputValueSchema` — should v1
  accept it (and ignore) or reject (and force a future change to
  add it)? Decision: **accept and ignore**. The factory author
  can write `shape:` today and have it survive a future
  validator without rewriting the factory; the validator
  enforces it only when the structural-typing change ships.

- The directory-type minimum file-count check — currently
  "≥1 file". A future revision may add `min_files:` /
  `pattern:` matchers. v1 keeps it boolean to avoid premature
  abstraction.
