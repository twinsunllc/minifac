---
status: accepted
date: 2026-05-21
supersedes: []
superseded-by: null
tags: [decision]
---

# 0027: Node outputs — typed inter-node data flow

## Context

Today, nodes pass essentially nothing structured to downstream
nodes. The `priorResults` array threaded into each node's
`RunContext` carries `{ nodeId, iteration, status, reason,
startedAt, endedAt }` — status metadata, not payloads. The
`reason` string is populated only on sentinel-reported failure
(see `extractReason` in `src/runner/run.ts:419`). Brief / run /
node-inputs are the only structured channels that *exist* in
the prompt-substitution surface.

That's fine for the bundled SDD factory, where each node has
one job and the next node mostly needs the work product on
disk (in the worktree's git tree). It is *not* fine for any
factory shape where structured findings need to flow between
nodes — a multi-perspective code review whose consolidation
node needs each reviewer's findings; a multi-step analysis
factory; anything fan-in–shaped.

[[0017-Callback-Status-Signaling]] sketched an opt-in HTTP
endpoint per node for bidirectional comms — primarily for
mid-run intervention. Outputs are related but distinct: they
are *unidirectional, structured payloads from node to runner*,
delivered through whatever channel best matches the data
shape. This ADR commits the outputs surface; 0017 remains the
intervention surface.

We surveyed prior art (notably the patterns used by
multi-stage agent runners that store typed stage results in a
database and inject prior results into the next stage's prompt
via template substitution). Their lessons applied: typed
declared outputs are worth the discipline; storage outside
the worktree avoids gitignore gymnastics; the consuming side
should pull via template substitution that the runner
mediates.

## Decision

Factories may declare outputs per node. The runner mediates
production, persistence, and consumption.

### Schema — per-node outputs declaration

```yaml
nodes:
  security-review:
    executor: claude
    with: { prompt: "..." }
    outputs:
      findings:
        type: value          # JSON payload
        required: true
        description: "Structured list of issues found"
      report:
        type: file           # one file at a path
        filename: report.md  # optional; default = model picks
        required: false
      attachments:
        type: directory      # multiple files
        required: false
```

Three output types:

- **`value`** — A JSON-typed payload. v1 transport is
  filesystem: the model writes `<outputs_dir>/<key>.json` and
  the runner reads it after the node terminates. (Future
  upgrade in [[0029-Node-Outputs-MCP]] replaces the filesystem
  hop with an MCP tool call, transparent to the factory.)
- **`file`** — One file at a declared or model-named path
  under `<outputs_dir>`.
- **`directory`** — A directory at `<outputs_dir>/<key>/` that
  the model populates with one or more files; downstream sees
  the directory.

### Storage — outside the worktree

Outputs live at `~/.minifac/outputs/<run-id>/<node-id>/<iteration>/`.
This location is:

- **Outside the run's git worktree.** No gitignore games, no
  pollution of the diff the run is supposed to produce.
- **Run-scoped, not branch-scoped.** Survives worktree
  pruning. Tied to the run record in `runs.db`.
- **Per-iteration.** Every iteration of every node gets its
  own directory. Nothing overwrites. Full history preserved.
- **Pruneable separately.** `minifac prune --outputs` reclaims
  disk; uses the same hybrid policy as worktree pruning.

The model is told its iteration's directory via a new
template token `{{ run.outputs_dir }}` substituted into the
prompt before dispatch.

### Production — model writes outputs

For v1 (this ADR), the model writes outputs to the
filesystem:

- `type: value`: write JSON to `<outputs_dir>/<key>.json`
- `type: file`: write to `<outputs_dir>/<filename>` (declared
  or chosen)
- `type: directory`: populate `<outputs_dir>/<key>/`

The prompt — written by the factory author — is responsible
for telling the model what to produce. The runner does not
inject output-emission instructions in v1 (analogous to how
the sentinel-emission injection is opt-out).

### Validation — runner checks after termination

After the executor terminates (sentinel parsed, exit code
captured), the runner runs a validation pass:

1. For each declared output with `required: true`:
   - `type: value`: does `<outputs_dir>/<key>.json` exist?
     Does its content parse as JSON and match the declared
     shape (string / number / boolean / array / object)?
   - `type: file`: does the declared / model-named file exist?
   - `type: directory`: does the directory exist with at least
     one file?
2. If any required output is missing or malformed, **override**
   the node's terminal status to `failed` with reason
   `missing_required_output`. `meta.missing_outputs` carries
   the list of missing keys.

Critically: required-output enforcement applies **only on
sentinel-succeeded nodes**. A failed sentinel short-circuits
the check — a node that honestly reported failure isn't
additionally blamed for not producing outputs it would have
produced had the work succeeded.

### Persistence

`NodeResult` gains an `outputs` field:

```typescript
interface NodeResult {
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  reason: string | null;
  outputs: NodeOutputIndex | null;   // NEW
  startedAt: number;
  endedAt: number;
}

interface NodeOutputIndex {
  [key: string]: {
    type: "value" | "file" | "directory";
    path: string;       // absolute path on disk
    size: number;       // bytes (value: JSON byte count; file: file size; directory: total size)
    mtime: number;
  };
}
```

`runs.db` gets a parallel `node_outputs` index table for
queryability. Contents themselves are not blob-stored in
SQLite; the filesystem is the source of truth.

### Consumption — template substitution

Downstream nodes consume via the existing substitution
mechanism, extended with a new top-level token:

```
{{ priorResults.<node-id>.outputs.<key> }}
```

This resolves to the **absolute filesystem path** of the
output. For `type: value`, the path points at the JSON file
the producer wrote.

When the consuming node needs the *contents* inline in the
prompt (not just the path), the `:read` suffix opts into
content interpolation:

```
{{ priorResults.security-review.outputs.findings:read }}
```

`:read` is bounded to small outputs (default 64 KB; configurable
later). Larger outputs without `:read` resolve to path only —
the model can then `cat` or `Read` the file via its tools.

**Latest iteration only in v1.** Per-iteration access (`:1`,
`:2`, etc.) is deferred until a concrete need surfaces. All
iterations are persisted; only template access defaults to
latest.

### CLI

- `minifac runs show <id> --outputs` — tree view of every
  output produced by every node iteration
- `minifac runs cat <id> <node-id>/<key>` — print one
  output's contents (latest iteration; or `<node-id>:N/<key>`
  for a specific iteration)
- `minifac prune --outputs [--older-than <duration>]` —
  reclaim disk

### Failure reason vocabulary

New value in the failure reason enum: `missing_required_output`.
Joins the existing `node_failed`, `graph_drained`,
`unknown_executor`, `user_quit`, `budget_exhausted`,
`sentinel_failed` set. Run-level exit code on a missing-output
failure: `2` (matches other node failures).

## Consequences

- **Factories can express fan-in shapes.** The code-review
  factory becomes feasible: three reviewer nodes produce
  `findings` outputs; the consolidation node references all
  three via templates.
- **The contract is enforced.** Declared required outputs
  aren't honored "if the model felt like it." Either the
  output landed or the node failed. Downstream nodes never see
  a `null` where a typed value was declared.
- **History is preserved.** Every iteration's outputs persist
  on disk and in `runs.db`. Inspectable post-hoc via
  `minifac runs show --outputs`.
- **No worktree pollution.** Outputs live outside the
  worktree; the run's PR contains only the substantive
  change.
- **Schema surface grows.** Factory YAML gains `outputs:`;
  `NodeResult` gains a field; substitution grows a token.
  None are breaking changes for existing factories.

## Alternatives considered

- **Pass payloads through the existing `reason` string.**
  Rejected — `reason` is one line, only populated on failure
  via sentinel REASON.
- **Per-stage-type hardcoded output schemas (`implement.pull_requests`,
  `review.findings` ...).** This is the pattern multi-stage
  agent runners often use. Rejected — too rigid for a
  general-purpose factory model; minifac doesn't ship
  stage *types*, it ships a uniform node abstraction.
- **Outputs in the worktree under `outputs/`, gitignored.**
  Rejected — worktree litter; gitignore enforcement depends
  on factory author discipline; outputs really aren't
  branch-scoped.
- **Blob storage in `runs.db`.** Rejected — SQLite gets fat
  fast with file payloads; filesystem is cheaper, navigable
  via `ls`, ready for `cat` / `grep` / etc.
- **`{{ priorResults.* }}` returns contents directly (no
  `:read` opt-in).** Rejected — would inflate prompts with
  large outputs by default; opt-in keeps the common case
  cheap.
- **Per-iteration template syntax in v1.** Deferred — full
  history is persisted; only the template ergonomic defaults
  to latest. Add `:N` syntax when someone asks.

## Open questions

- Should the runner inject standard "remember to write your
  outputs to {{ run.outputs_dir }}" boilerplate into prompts
  (analogous to sentinel injection)? Leaning *no* for v1 —
  factory authors should be explicit. Revisit if missing-output
  failures dominate.
- What's the right cleanup cadence for old outputs? Defer
  until disk pressure becomes a real concern; the manual
  `minifac prune --outputs` is the v1 lever.

## Related

- [[0014-Structured-Prior-Results]] — established the
  `priorResults` channel; this ADR extends it with payload
- [[0017-Callback-Status-Signaling]] — bidirectional
  intervention surface; distinct from outputs
- [[0028-Node-Outputs-Nudge]] — recovery loop when required
  outputs are missing
- [[0029-Node-Outputs-MCP]] — transport upgrade for `value`
  outputs (filesystem → MCP)
- [[Factory]], [[Step]] — concept docs that will gain schema
  entries when this lands
