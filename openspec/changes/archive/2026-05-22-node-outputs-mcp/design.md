## Context

`node-outputs` shipped the v1 filesystem-JSON transport for
`type: value` outputs: the model writes `<outputs_dir>/<key>.json`
with its existing Write tool, and the runner validates after
termination. That contract works, but the model forgets writes
more often than it forgets tool calls, schema mismatch is
diagnosed post-hoc by the validator (not in-context by the
model), and the JSON write is invisible in the stream-json event
stream — the TUI / web viewer see "tool_use(Write) findings.json"
instead of a structured "output reported" event.

`docs/decisions/0029-Node-Outputs-MCP.md` records the binding
choices for the upgrade:

- Replace the filesystem transport for `value` outputs with an
  inline MCP server exposing dynamically-generated typed tools
  per dispatching node.
- `file` and `directory` outputs stay filesystem-written — MCP
  doesn't help when the natural shape is a file.
- One MCP server per run on a unix socket in the per-run state
  directory.
- Tool calls bridge to the same JSON path the v1 transport used,
  so downstream consumers (templates, `runs.db`, `runs cat`, the
  validator) keep working unchanged.
- Non-MCP executors (none in v0; future runners) fall back to the
  v1 filesystem transport via a `supportsMcp` capability flag on
  the executor interface.

This change implements those choices. It plugs into the storage
layout established by `node-outputs` without changing it — the
on-disk contract is the load-bearing interface, and MCP is a
delivery upgrade for one of the two writer paths.

## Goals / Non-Goals

**Goals:**

- A single transport upgrade for `value` outputs with no change
  to the on-disk contract: the validator, `runs.db`, template
  substitution, and CLI surfaces all keep working unchanged.
- Per-node tool scoping so a node cannot report outputs on
  another node's behalf — the affordance is generated from the
  dispatching node's declared `outputs:` and torn down at
  termination.
- Schema enforcement at tool-call time so malformed payloads
  fail loud in the model's working context (the model
  self-corrects on the next turn without needing the separate
  `node-outputs-nudge` recovery loop in the common case).
- A clean fallback path for executors that don't speak MCP. The
  filesystem transport stays as the second-class but
  always-available path.
- Real-time visibility: tool calls flow through the existing
  `onEvent` stream as `tool_use` events, so the TUI / web viewer
  see "outputs reported" in the right place in the event
  timeline.

**Non-Goals:**

- Changing the on-disk path layout established by `node-outputs`.
- A schemaless `report_output(key, value)` MCP tool. Typed-per-
  output tools are the v1 default; the schemaless form can come
  later as a "free-form output" affordance.
- `attach_file_output` / `attach_directory_output` confirmation
  tools. The runner detects files on disk without them.
- Cross-node tool visibility. A node SHALL see only its own
  outputs' tools.
- Structural typing beyond `array` / `object` / primitive for
  `value` outputs. The `shape:` slot is accepted by the schema
  but the MCP layer treats `value` payloads with loose schemas
  in v1 — `z.array(z.any())` for `array`-shaped, `z.object({}).passthrough()`
  for `object`-shaped, primitive schemas for primitives.
- HTTP MCP transport or any backend other than the SDK's
  socket / stdio. (HTTP is the right transport for
  `0017-Callback-Status-Signaling`'s bidirectional intervention
  surface, not for one-way output reporting.)
- Output-missing recovery / nudge logic. Separate change.
- Changes to the post-execution validator's logic. It still
  scans `<outputs_dir>` after the executor terminates.

## Decisions

### D1. One MCP server per run, not per node

Lifecycle: started in `runFactory` setup (after the run id is
minted and the outputs root resolved), stopped at run termination
(in the same `finally` block that already closes the store).

Alternatives considered:

- **One server per node.** Would mean a server spinning up and
  down on every dispatch. Wasteful and forces the executor to
  re-resolve the socket path per call. Rejected.
- **One server per process (singleton across runs).** Would
  conflate concurrent runs (the TUI's `--auto` mode dispatches
  multiple runs over its lifetime) and would force tool
  registrations to carry a `runId` parameter. Rejected; per-run
  is the right scoping.

Per-run also matches the per-run state directory layout
already established by `node-outputs`: the socket lives at
`${MINIFAC_HOME}/outputs/<run-id>/../mcp.sock` (one level up from
the per-node outputs dirs, alongside them in the per-run state
tree). The `.mcp.json` file emitted per dispatch points at the
same socket.

### D2. Per-node tool registration, derived from declared outputs

When a node is dispatched, the runner registers MCP tools
generated from that node's `outputs:` block — one tool per
`type: value` output, named
`mcp__minifac__report_<output-key>`. Tool registrations are
torn down at node termination so the next dispatched node sees
only its own tools.

Why per-node and per-output (not per-run and schemaless):

- A node should not be able to report on another node's behalf.
  Cross-node tool visibility is gibberish in the directed-graph
  model (per ADR-0029 "Alternatives considered").
- Typed tools give the model a strong front-and-center signal
  about what shape each output expects. A schemaless
  `report_output(key, value)` would push the type-checking onto
  the bridge layer, defeating the "fail loud in-context" goal.

`file` and `directory` outputs do NOT get MCP tools — they stay
filesystem-written by the model's existing tools (Write, Edit).
The validator detects them on disk after termination, unchanged
from `node-outputs`.

### D3. Tool schema derived from declared output type

`type: value` outputs get an MCP input schema derived from any
`shape:` hint present, with loose defaults:

- `shape: { items: "array" }` or similar → `z.array(z.any())`
- `shape: { fields: { ... } }` or similar → `z.object({}).passthrough()`
- `shape:` absent → `z.unknown()` (accept any JSON-serializable
  value)
- Future structural-typing extensions can tighten these.

Loose schemas reflect the `node-outputs` decision to reserve
`shape:` as a forward-compatible slot without committing to a
structural-typing implementation in v1. The MCP layer mirrors
that posture: it enforces JSON-shape (parseable, structurally
sound) without enforcing structural typing yet.

The tool's `description` field SHALL be the declared output's
`description` if present, falling back to a generic
`"Report the <key> output for this node."` string.

### D4. Bridge to the v1 filesystem layer is load-bearing

When a tool call lands, the bridge:

1. Validates the payload against the derived MCP schema
   (defensive double-check — the SDK validates first).
2. Serializes to JSON (stable, deterministic — sorted keys,
   2-space indent for readability when an operator opens the
   file).
3. Writes `<outputs_dir>/<key>.json` atomically (write to a
   `.tmp` sibling, rename into place) so a torn write doesn't
   confuse the validator.
4. Updates the in-runner outputs tracking — a per-dispatch map
   from output key to "reported via MCP" / "reported via FS" /
   "not yet reported" — so the post-execution validator can
   read it instead of restating from disk for the MCP cases
   (saves one stat per output).

Why on-disk in addition to in-memory tracking:

- The validator already reads from disk. Keeping the on-disk
  side authoritative means MCP and filesystem paths converge at
  the validator with zero conditional code.
- Downstream consumers (template substitution's `:read` suffix,
  `runs cat`, `runs show --outputs`) all read from disk. The
  MCP transport CANNOT bypass disk without rewiring every
  consumer.
- The in-memory tracking is a hint, not the source of truth —
  the validator's stat-based pass remains correct even if the
  in-memory tracking is missing an entry.

Atomic write rationale: a model that calls
`report_findings(...)` and then crashes mid-write would otherwise
leave a half-formed `findings.json` that the validator parses as
"present-but-invalid" — which counts as missing for the
required-output purposes (per `node-outputs`'s validation rules)
but loses the "the model tried" signal. Atomic rename via `.tmp`
sibling means we either see the full payload or no file at all,
keeping the failure mode boolean (absent vs present) rather than
tri-state.

### D5. `.mcp.json` is per-dispatch, transient

Emitted to `<outputs_dir>/.mcp.json` (inside the per-node
outputs directory the runner already creates per dispatch).
Pointing at the run-level socket means every dispatch reuses
the same server; only the config file is per-dispatch.

Why per-dispatch:

- The dispatched node's tool surface is what the model sees
  through this config. While the socket is run-scoped, the
  `mcpServers.minifac.tools` filter (or equivalent SDK
  affordance) could in principle be set per-dispatch — but
  for v1 we keep the config minimal and rely on the server's
  per-node registration to scope the surface.
- A per-dispatch file also lives inside the directory the runner
  already mkdirps and which gets pruned by
  `prune --outputs`, so cleanup is free.

Why not per-run:

- The simplest possible `.mcp.json` would be one per run,
  reused across dispatches. We're going per-dispatch instead
  because the runner already creates the per-node outputs
  directory, the cleanup story is already solved at that
  granularity, and keeping the file co-located with the outputs
  directory makes the "what did this node see" diagnostic story
  straightforward (an operator can open the per-node directory
  and see both the outputs and the config that was in scope).

Cleanup: the `.mcp.json` is removed at run termination alongside
the socket close. Per-dispatch cleanup of just the config file
without the outputs would leak the outputs directory's
diagnostic value.

### D6. Executor capability flag, not runtime detection

The `NodeExecutor` interface grows `readonly supportsMcp: boolean`.
Claude sets `true`; future executors set `false` (and the runner
falls back to the v1 filesystem transport for `value` outputs on
those nodes).

Alternatives considered:

- **Detect at dispatch time** (e.g., look at the executor's type
  field). Coupling. Rejected — capability flag is the established
  pattern in this repo (`docs/decisions/0013-Anti-Goals.md`
  rules out "untyped runner registries / plugin systems before
  there's a second runner," but a single capability flag on the
  one existing executor is the minimum forward-compatible
  surface — adding it now costs nothing and lets the second
  executor (when it arrives) declare its own capability without
  touching the runner).

When `supportsMcp` is false, the runner SHALL NOT:

- Pass `--mcp-config` on the CLI invocation (the CLI doesn't
  speak MCP).
- Register tools for the node (no client to call them).

The runner SHALL still:

- Start the MCP server for the run (other nodes in the same run
  may use it).
- Run the post-execution validator (the model writes files at
  the same paths via its own Write tool; the validator scans
  them regardless of how they got there).

### D7. Fail-loud at tool-call time

The MCP SDK's input-schema enforcement rejects malformed
payloads before the tool body runs. The runner's bridge
double-checks defensively (paranoia is cheap; an SDK upgrade
loosening some validation case shouldn't silently corrupt the
outputs layer).

When validation fails, the tool returns an MCP error to the
model. The model sees the error in-context on the next turn and
self-corrects (re-call the tool with the fixed payload). No
runner-side intervention is required for the common case.

If the model never self-corrects and the node terminates without
the required output landing, the post-execution validator catches
it via the same `missing_required_output` override path
`node-outputs` already ships — the second line of defense is
unchanged.

### D8. MCP SDK dependency

Use the official MCP TypeScript SDK
(`@modelcontextprotocol/sdk`). Reasoning:

- It's the standard, maintained by the protocol's authors.
- It handles socket / stdio multiplexing, framing, and message
  ordering — we don't want to re-implement JSON-RPC framing.
- The SDK is small and stable.

Locked via the existing dep-freshness CI gate from
`docs/decisions/0024-CI-Security-Policy.md`: the version we lock
must be at least 3 days old at the time `cli.yml` runs (no
hot-publish supply-chain attacks).

The verified-publisher policy in 0024 SHALL be updated to
acknowledge the new SDK dep in the same way other transitive
deps were acknowledged when they landed.

### D9. Per-run socket path is not in `config.yaml`

The socket lives at
`${MINIFAC_HOME}/outputs/<run-id>/../mcp.sock` (equivalently
`${MINIFAC_HOME}/outputs/<run-id>.mcp.sock` — but the "../"
form is more honest about it being a sibling of the per-run
outputs tree). It is computed by the runner at run start; no
operator override is needed in v1.

Why not put it in `config.yaml`:

- It's a runtime detail of the per-run state layout, not a
  factory- or operator-level knob. Operators don't tune socket
  paths; the runner picks one per run.
- Surfacing it in `config.yaml` would invite operators to point
  it at exotic filesystems (NFS, FUSE mounts) where unix-socket
  semantics are squirrely. Better to keep it implicit and
  local.

It IS documented in `docs/Config.md` (the per-run state
directory layout section) so an operator debugging a run knows
where to look.

## Risks / Trade-offs

- [SDK breaking changes in a minor bump strand minifac on an
  older version] → Lock to a specific version range
  (`^x.y.z`), exercise the version in CI, and gate upgrades
  behind a manual review (the dep-freshness CI gate already
  prevents day-zero adoption of new releases).

- [Per-node tool tear-down race: model calls
  `report_findings(...)` after the runner has already de-registered
  the tools] → The MCP server's per-node tool registrations
  SHALL be torn down only after the executor's event stream has
  fully drained (the same termination point the validator
  observes). A tool call that lands during the drain SHALL
  still succeed; a tool call that arrives after de-registration
  SHALL return an MCP "unknown tool" error. The model can't
  recover from that, but the validator will catch the missing
  output at termination — same failure mode as today.

- [Unix-socket semantics on Windows] → minifac is Node-on-darwin/
  -linux for v1 (per CLAUDE.md). Windows is not a target.
  When a Windows target eventually lands, the SDK supports
  named-pipe transport on Windows; the per-run path becomes
  a named pipe instead of a unix socket. The proposal's
  socket-path-in-per-run-dir convention extends naturally.

- [Operator confusion: which transport did this node use?] →
  The post-execution validator's reason text SHALL include the
  transport when a `missing_required_output` fires
  ("expected value output `findings` via MCP" vs. "via
  filesystem"). The TUI / web viewer also distinguish
  `tool_use(mcp__minifac__report_findings)` events from
  `tool_use(Write)` events naturally — the operator sees the
  difference in the event log.

- [Atomic rename failures on exotic filesystems (cross-device
  link errors)] → The bridge MUST write the `.tmp` sibling to
  the same directory as the final `<key>.json` (which is
  guaranteed to be the same filesystem). Cross-device rename
  isn't possible by construction.

- [The schemaless model: someone wanting to report an output
  with no declared type] → Out of scope. The factory declares
  outputs ahead of time; reporting a non-declared output via
  MCP SHALL return an MCP "unknown tool" error. If a future
  use case wants free-form outputs, a separate change can add
  the schemaless `report_output(key, value)` tool. The v1
  surface is intentionally narrow.

## Migration Plan

No data migration is required — the on-disk contract is
unchanged. The new dependency is additive.

Existing factories with `type: value` outputs continue to work
unchanged in two senses:

1. The model's existing Write-based output emission still
   produces files at the same paths. The post-execution
   validator picks them up regardless of transport.
2. When the new MCP tools are exposed, the model is expected
   to prefer them over the Write path (typed tools with
   front-and-center descriptions are a stronger affordance than
   a magic file path). But if the model still uses Write, the
   validator catches the file the same way.

There is no breaking change for factory authors. There is no
runtime-config flag to toggle the transport on/off in v1 —
MCP is on whenever an MCP-capable executor (Claude) is in scope,
and the filesystem path is always the second-class fallback.

## Open Questions

- Should we expose the MCP tool list in `runs show` as a
  diagnostic? (Probably yes, but deferred until a real
  operator needs it.)
- Does the MCP SDK expose a "per-client tool filter" affordance
  that would let us scope tools at the server-config layer
  instead of (or in addition to) the registration layer? If
  yes, we could simplify the per-node tear-down story. v1 ships
  the registration-layer scoping regardless; the filter
  affordance is a future simplification.
