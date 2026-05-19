## Why

minifac is pre-zero — there is nothing to run yet. To get to a meaningful
first milestone, we need the smallest possible end-to-end slice: load a
factory from YAML, execute its nodes in graph order (with cycles), stream
output from a Claude node, and exit. Everything we layer on later (daemon,
web viewer, beads/dolt storage, additional runners, SDD factory) assumes
this core exists. Building it first also forces us to make the load-bearing
schema and runner-interface decisions explicit, in a spec, before code
crystallizes around them.

## What Changes

- Introduce a YAML factory schema: typed nodes with directed edges,
  cycles permitted, per-node iteration budgets, optional human-in-the-loop
  gate marker. Snake_case keys; validated at load time.
- Introduce a graph runner: loads a factory, resolves the start node(s),
  executes nodes respecting edges and cycle budgets, terminates on a
  declared end condition or budget exhaustion.
- Introduce a node-executor interface and one concrete implementation,
  `claude`, which invokes the Claude CLI in stream-json mode for both
  input and output and surfaces messages + exit status as the node's
  events.
- Introduce a run-wide event log that accumulates across the whole run
  (including cycles) and is passed as input to each scheduled node. A
  second iteration of the same node in a cycle therefore sees its own
  prior outputs, so issues that recur across iterations are visible
  rather than hidden.
- Introduce a `minifac run <factory>` CLI that loads, validates, and
  executes a factory file, streaming node output to the terminal.
- Ship a `hello.yaml` example factory that demonstrates a single Claude
  node running end-to-end.
- Set up the TypeScript project skeleton (package.json, tsconfig, lint,
  test runner) that all subsequent changes will build on.

Explicitly **out of scope** for this change (slated for follow-ups):
`minifac serve` daemon, web viewer, beads/dolt storage adapters,
additional runners (codex/opencode), the SDD example factory, fan-out /
rejoin semantics beyond what cycles already provide.

## Capabilities

### New Capabilities

- `factory-schema`: YAML schema for factory definitions — nodes, edges,
  cycles, iteration budgets, executor references — plus the loader and
  validator that produce a typed in-memory representation.
- `graph-runner`: in-process orchestrator that walks the factory graph,
  schedules nodes, enforces cycle/iteration budgets, and surfaces a
  structured run result.
- `node-executor`: typed interface for executing a single node, plus the
  concrete `claude` executor that streams the Claude CLI.
- `run-cli`: `minifac run <factory>` command — argument parsing, factory
  resolution, run invocation, terminal output streaming, exit codes.

### Modified Capabilities

<!-- None — this is the foundational change. -->

## Impact

- New package: a single TypeScript package at the repo root (no monorepo
  split until justified). Establishes the project's build, lint, and test
  toolchain.
- New runtime dependency: the `claude` CLI must be on `$PATH` to run the
  `hello.yaml` example. The executor surfaces a clear error if missing.
- No storage layer yet — runs are ephemeral; output goes to the terminal.
  This is intentional and explicitly revisited by the future
  `beads-dolt-storage` change.
- Establishes the schema and executor interface that all future runners
  and storage backends must conform to. Changing either later is a
  spec-level change, not a refactor.
