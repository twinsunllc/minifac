## Context

minifac is a brand-new repo with no code. The proposal commits us to a small
TypeScript core: a YAML-defined directed graph (cycles allowed) of nodes,
executed by an in-process runner, with a Claude-CLI-streaming executor as the
only runner in v0. Every subsequent change (daemon, web viewer, pluggable
storage, SDD example factory, additional runners) builds on the schema and
executor interface chosen here, so we want those two surfaces to be tight and
considered now — even though the implementation can be small.

Constraints carried in from `CLAUDE.md`:

- One TypeScript package. No monorepo split until justified.
- Snake_case YAML keys.
- Cycles are first-class — don't accidentally encode DAG-only assumptions.
- Claude is the only runner for v0, but its executor implementation must
  conform to a typed interface so codex/opencode can slot in later.
- Strict TypeScript. No `any` without a comment.

## Goals / Non-Goals

**Goals:**

- A factory YAML file loads into a fully typed, validated in-memory
  representation. Invalid factories fail at load with a clear, locatable
  error.
- A graph runner can execute that factory, walking edges, looping through
  cycles within declared budgets, terminating cleanly on success, budget
  exhaustion, or node failure.
- A `claude` node executor spawns the Claude CLI in streaming mode and
  surfaces stdout/stderr line-by-line as the node runs.
- `minifac run hello.yaml` executes the shipped example factory end-to-end,
  streaming Claude output to the terminal, and exits with a sensible code.
- The executor interface is small enough that adding a second runner later
  is straightforward and reviewable.

**Non-Goals:**

- No daemon, no web UI, no HTTP, no IPC. CLI-only foreground execution.
- No persistent storage of any kind. Runs are ephemeral; nothing is
  recorded after the process exits.
- No beads, no Dolt, no SQLite. (All deferred to a later change.)
- No additional runners. Only `claude`.
- No fan-out / rejoin primitives beyond what cycles + multiple edges already
  permit. Iteration patterns (explore/exploit, N-variant) are a later change.
- No human-in-the-loop UI. A node may declare itself a gate, but the v0
  behavior is simply to halt the run with a clear message — no prompt, no
  resume. Resumption arrives with the daemon.

## Decisions

### Decision: TypeScript on Node 22+ LTS

**Why:** The user picked TypeScript explicitly. Node 22 is current LTS,
gives us native `node:test` if we ever want it, modern `child_process`
streaming, and `--experimental-strip-types` if we want ts-node-less dev.

**Alternatives considered:** Bun (faster, but Node compatibility tax for
the daemon work later); Deno (great std lib, but smaller ecosystem for the
specific deps we'll touch); Go/Rust (rejected by the user, and overkill
for a CLI orchestrator).

### Decision: Zod for schema validation; `yaml` package for parsing

**Why:** Zod gives us a single source of truth for both the runtime
validator and the static TypeScript types — `z.infer<typeof FactorySchema>`
is the in-memory representation. The `yaml` package preserves source
positions, which lets us emit error messages that point at the right line
and column.

**Alternatives considered:** AJV + a hand-written types file (more code,
two sources of truth); valibot (slightly faster but smaller community);
io-ts (more complex error model than we need).

### Decision: Async-generator executor interface

A node executor exposes:

```ts
interface NodeExecutor {
  readonly type: string; // e.g. "claude"
  run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent>;
}

type NodeEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "status"; status: "started" | "succeeded" | "failed"; meta?: unknown };

interface RunContext {
  readonly factory: Factory;
  readonly history: ReadonlyArray<RunHistoryEntry>; // see "history pass-through"
  readonly nodeId: string;
  readonly iteration: number; // 1-based count of this node's executions so far
}
```

**Why:** Streaming is the whole point. Async iterables compose naturally
with the runner's scheduling loop, are easy to test (yield events directly
from a fake), and don't couple the executor to a specific transport (CLI
terminal today, WebSocket later, log file in between). The interface is
small — three event kinds — which makes adding a second runner low-cost.

**Alternatives considered:** EventEmitter (untyped events, harder to
exhaustively handle); callback API (callback hell when composing); whole-
result Promise (defeats streaming).

### Decision: Run-wide event history is passed forward to every node

The runner maintains a single ordered `RunHistoryEntry[]` for the entire
run — every event from every node, in emission order, tagged with the
emitting node id and that node's iteration count. Each scheduled node
receives a read-only snapshot of this history at the moment it starts via
`RunContext.history`. Executors decide how to use it; the `claude`
executor serializes it onto the CLI's stream-json input.

```ts
type RunHistoryEntry = {
  nodeId: string;
  iteration: number;     // which iteration of that node emitted this event
  emittedAt: number;     // monotonic ms since run start
  event: NodeEvent;
};
```

**Why:** Cycles are the feature, and the value of a cycle is being able to
*see* what changed (or didn't) across iterations. A propose → apply →
verify → propose loop where propose can't see verify's prior complaints is
just an expensive re-roll. A single run-wide history is the simplest model
that captures this: lossless, ordered, and trivial to filter or fold per
executor without baking a per-path data flow into the schema.

**Alternatives considered:** Per-path history (more "correct" for fan-out
graphs, but we have no fan-out primitives yet and it forces an
edge-payload concept into the schema for no v0 benefit); per-node declared
inputs in YAML (premature — we don't know what shapes are useful yet);
no history at all (defeats the point of cycles).

### Decision: Claude CLI uses stream-json for both input and output

The `claude` executor invokes the CLI with `--input-format stream-json`
and `--output-format stream-json`, piping a stream-json document
constructed from the node's `with.prompt` plus the run history onto
stdin, and parsing the CLI's stream-json output line-by-line into
`stdout` events.

**Why:** Stream-json is the right shape for what we already want:
structured, streaming, message-oriented in and out. Using it on both
sides means the run history can be replayed as actual messages rather
than flattened into a single prompt blob, which preserves turn structure
and makes future runners (codex, etc.) easier to feed in a similar
shape.

**Trade-off:** Stream-json's exact line shape is a moving target. The
adapter in `claude-runner.ts` owns this concern; the executor's outward-
facing contract (`stdout` line events, terminal `status`) does not
change when the CLI surface evolves.

### Decision: A node's `cwd` is honored verbatim by the runner

The factory schema reserves `cwd: <string>` at the node level. The
runner resolves it relative to the factory file's directory and passes
the resolved absolute path to the executor via `RunContext`. Executors
that spawn child processes (e.g. `claude`) use it as the process cwd;
executors that don't (a future in-memory executor) may ignore it.

**Why:** SDD-style factories operate on a target repo, often a different
directory from the factory file itself. Reserving the key now means the
shape is set when we add the SDD example factory later, even though v0
only has one runner using it.

### Decision: Cycles are bounded by construction; loaders reject unbounded cycles

Every cycle-creating edge requires either:

- a `max_traversals: N` on the edge, **or**
- a `max_iterations: N` on a node that participates in the cycle.

If the loader detects a cycle without any budget covering it, validation
fails. The runner enforces the budgets at scheduling time. Budget
exhaustion terminates the run with a distinct, non-zero exit code.

**Why:** Cycles are the feature, but unbounded cycles are an
infinite-loop footgun, and "the runner detected we've been looping forever"
is a worse user experience than "the loader told you to declare a budget."
Force the declaration up-front.

**Alternatives considered:** Global iteration cap (too coarse — different
cycles need different budgets); runtime detection only (no validation
catches the mistake before a run).

### Decision: A node is `terminal: true` to mark a successful end state

The runner ends a run successfully when a node with `terminal: true`
completes. If the graph drains (no schedulable nodes) without reaching a
terminal node, the run is treated as failed — that almost certainly means
the factory is mis-modeled.

**Why:** Explicit beats inferred. "No outbound edges" is ambiguous (could
mean "stop here" or "this node should have had an edge"). Requiring an
explicit terminal marker eliminates that ambiguity.

### Decision: CLI via `commander`; output via direct stdout writes

`minifac run <factory>` parses args with commander, loads the factory,
runs it, and writes node events line-by-line to stdout/stderr with a
small `[node-id] ` prefix. Exit codes:

- `0` — run reached a terminal node
- `1` — usage / schema / load error
- `2` — node failed
- `3` — budget exhausted

**Why:** commander is the most boring, well-typed CLI lib in the Node
world. Prefixed line-streaming is the simplest output format that
multiplexes multiple nodes legibly; once we have a UI we can drop the
prefix in favor of per-node panes.

**Alternatives considered:** yargs (heavier API for no gain at this size);
clipanion (less ubiquitous); hand-rolled (we'd add features back).

### Decision: vitest + biome; no eslint/prettier split

**Why:** vitest is the default modern TS test runner. biome handles both
lint and format in one config file, runs fast, and removes the
eslint/prettier coordination tax. Minimal toolchain is itself a project
value.

## Risks / Trade-offs

- **[Claude CLI surface drifts]** → Mitigation: confine all knowledge of
  the `claude` CLI (flags, output format, environment) to a single
  `claude-runner.ts` file. Treat it as an adapter. Spec a contract for what
  the runner emits, not what it reads from the CLI.
- **[Async-iterable backpressure is subtle]** → Mitigation: the v0 runner
  consumes events as fast as they arrive and writes them straight to
  stdout. No buffering layer means no backpressure surprises until we
  intentionally add one (e.g. with the daemon).
- **[Schema rigidity blocks future runners]** → Mitigation: nodes carry an
  open-shape `with:` object passed verbatim to the executor; the Zod schema
  validates only the structural envelope, while each executor validates
  its own `with:` payload. Adds a runner without touching the core schema.
- **[Terminal-node convention surprises users]** → Mitigation: schema
  validation requires at least one `terminal: true` node and emits a clear
  error when missing. Document the rule in the schema spec.
- **[Cycles + terminal nodes interact oddly]** → Mitigation: terminal nodes
  participating in cycles are explicitly permitted (e.g. verify ends the
  run on success but cycles back on failure). Document this in the
  graph-runner spec with a scenario.
- **[Run history grows unboundedly]** → Mitigation: cycle budgets already
  cap the maximum iterations, which caps the maximum history size in
  practice. v0 does no truncation or summarization. If real factories run
  long enough to make this hurt, a later change introduces per-node
  history filters (e.g. "only the last verify output") — but that's a
  feature, not a fix to add prematurely.
- **[Stream-json CLI surface drifts]** → Mitigation: confine the framing
  to `claude-runner.ts`; the executor's outward contract is unchanged.
  Snapshot-test the wire format we send so regressions in our serializer
  are caught even when the CLI evolves.

## Migration Plan

N/A. Foundational change to an empty repo. No deployed users, no data, no
existing API.

## Open Questions

- **Stream-json wire shape.** The exact JSON envelope we send to
  `claude --input-format stream-json` (system vs user message roles, how
  to tag prior-node events, whether each history entry becomes its own
  message or rides inside a single user message) is for the implementation
  phase. Apply must commit to a shape and snapshot-test it.
- **History size in long-running loops.** Cycle budgets bound history
  in practice, but a factory that runs at the top of every cycle budget
  still ships a large blob to the executor. Revisit if real factories
  hit it; out of scope for this change.
