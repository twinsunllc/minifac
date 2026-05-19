## Why

minifac dogfoods Spec-Driven Development on itself — every behavior change
runs through `propose → apply → verify → archive`. We do that loop today
by hand. Shipping it as a factory does two things at once: (1) gives
anyone with an OpenSpec-equipped repo a working SDD runner they can point
at their own target repo, and (2) gives minifac a real second example
beyond `hello.yaml` so the schema, runner, and `claude` executor are
exercised by something with cycles, failure routing, and multiple nodes.
`CLAUDE.md` already commits to shipping `sdd.yaml` alongside `hello.yaml`;
this change makes good on that promise.

## What Changes

- Add `examples/sdd.yaml` — a four-node factory implementing the
  propose → apply → verify → archive loop. Nodes are all `claude`
  executors. The verify node loops back to apply on failure with a
  bounded retry budget.
- Add `examples/sdd.md` — per-node contract documentation describing
  what each node's prompt must accomplish, the OpenSpec CLI commands
  each invokes, and the expected success signal. (Documentation, not
  a spec.)
- Update `README.md`'s "Run the example" section to reference `sdd.yaml`
  alongside `hello.yaml` and explain how to point it at a target repo.
- Add a load-time test that parses `examples/sdd.yaml` and asserts the
  resolved start nodes, terminal node, and cycle budgets match the
  documented contract.

No new dependencies. No new executors. No new runner features. No new
schema fields. The factory runs against today's v0 using only the
`claude` executor and per-node `cwd`.

Explicitly **out of scope** for this change:

- A `shell` executor. Verify runs commands via the `claude` node (which
  has tool access in the target repo). A native `shell` executor is its
  own change.
- Factory-level `cwd` defaults / templating. Every node in `sdd.yaml`
  carries the same `cwd: <target-repo>`. Reducing that friction (a
  top-level `cwd:` default, or `--var change=<name>` templating) is
  noted as friction in `design.md` but deferred.
- Driving the factory against minifac itself in CI. The factory is
  shipped as a working example; orchestrating it as a release gate is
  not in this change.

## Capabilities

### New Capabilities

- `sdd-factory`: the canonical SDD example factory shipped with the
  repo. Defines, at the spec level, the contract minifac commits to:
  the factory's topology (nodes, edges, failure routing), the
  per-node responsibility (what each node must accomplish, the
  OpenSpec CLI commands it invokes), and the cycle budgets. Constrains
  what changes to this example require a new proposal vs. a docs tweak.

### Modified Capabilities

<!-- None. This change ships a new example using only the v0 schema,
runner, and claude executor. No requirements on `factory-schema`,
`graph-runner`, `node-executor`, or `run-cli` change. -->

## Impact

- New file: `examples/sdd.yaml` — the factory itself.
- New file: `examples/sdd.md` — per-node contract documentation,
  alongside the YAML so it's discoverable.
- Modified file: `README.md` — points to the new example and how to use it.
- New test: a load-and-resolve test for `examples/sdd.yaml` that runs
  without invoking `claude` (asserts shape only).
- Runtime expectation: running the factory requires the target repo to
  have OpenSpec installed and a change name available. The factory
  itself does not impose those — it surfaces failure clearly when the
  preconditions aren't met (via the verify or propose node's own
  output).
- No impact on existing canonical specs.
