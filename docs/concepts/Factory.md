---
tags: [concept]
aliases: [factories]
---

# Factory

A factory is a workflow definition: a directed (possibly cyclic) graph
of nodes with edges declaring how control flows. Factories are
*infrastructure* — they live with the minifac tool (as built-in
canonical templates like `minifac:sdd`) or in
`.minifac/factories/<name>.yaml` per repo (custom or extended).

## Anatomy

- **Nodes** have a unique id and either:
  - inline behavior — an [[Executor]] type and a `with:` payload that's
    executor-specific (e.g. `prompt`, `permission_mode`), OR
  - a `uses:` reference to a reusable [[Step]] with an optional
    `inputs:` block supplying values to the step's typed inputs.

  Both shapes accept the per-node fields: optional `cwd`, an optional
  `terminal: true` marker, an optional `start: true` marker, and an
  optional `max_iterations` budget.
- **Edges** carry `from` / `to` / optional `when` (`on_success` default,
  `on_failure`, or `on_error`) and an optional `max_traversals` budget.
  A node **fails** when it ran and judged failure, and **errors** when
  its executor could not produce a judgment (a crash, a timeout, a rate
  limit, an unparseable result). An error takes the node's `on_error`
  edges when it declares any and its `on_failure` edges otherwise; a
  failure never takes `on_error`. `on_error` edges count against
  `max_traversals` like any edge. See [[0052-On-Error-Edges]].
- **Value edges** route on a node's result rather than its outcome:
  `when: { output: result.decision, equals: revise }` or
  `when: { output: result.decision, in: [revise, rework] }`. On a success
  or a judged failure, the value edges that match replace the outcome's
  `on_success`/`on_failure` edges; with none matching, the node follows
  those edges as usual. An error never takes a value edge. See
  [[#Routing on a value]] and [[0055-Value-Edges-And-Node-Routing]].
- **Routes** let a node choose what runs next from a declared allow-list:
  `routes: [implement, checks_gate]`. The node writes `next` (one of its
  routes, or `null`). A route it names is taken alone, ahead of value
  edges and outcome edges. Routes count as edges for start nodes and
  cycle budgets. See [[#Node-chosen routing]].
- **Start nodes** are nodes with no inbound edge from another node —
  of any kind — plus any node declaring `start: true`. A node reached
  only by `on_failure` edges (an escalation, wait, or re-poll node) is
  *not* a start node; it runs only when that edge fires. A cycle's
  entry node has a back-edge into it, so it declares `start: true`.
  Self-loops don't count. Zero start nodes is a load error naming the
  cycle. See [[0040-Declared-Start-Nodes]].
- **Terminal node** with `terminal: true` ends the run on success. A
  terminal node's outbound edges are followed only when it fails, and
  its routes only on a judged failure; see "Node-chosen routing" below for the load warning on a
  terminal node that declares `routes:`.
- **[[Cycle]]s** are first-class but must be bounded — see
  [[0002-Cycles-First-Class]].

## Steps

A node can decline to declare `executor:` + `with:` and instead point
at a published [[Step]] via `uses:`. The step file ships its own
`executor`, `with` body, and a typed input schema; the factory node
supplies values for those inputs and inherits the step's behavior.

```yaml
# .minifac/factories/sdd.yaml
extends: "minifac:sdd"
nodes:
  verify:
    uses: minifac:openspec-verify
    inputs:
      change: "{{ brief.change }}"
      commands: ["bun test", "bun run build"]
    cwd: "{{ run.cwd }}"
```

The loader resolves `minifac:openspec-verify` against the bundled
package first, then the source-tree fallback:

1. `<install-root>/examples/steps/openspec-verify.yaml` (the copy
   shipped in the npm tarball — the canonical "stdlib" version)
2. `<callerCwd>/examples/steps/openspec-verify.yaml` (the source-tree
   dogfood copy, present when running from a checkout)

The same install-root-first / source-tree-fallback precedence applies
to `extends: minifac:<name>` and to factory-by-name resolution
(`--factory minifac:<name>`, brief `factory: minifac:<name>`). Bare
references (`<name>` without the `minifac:` prefix) stay user-local —
they consult `.minifac/factories/<name>.yaml` and the local
`examples/<name>.yaml`, but never the install root. The loader then
type-checks the supplied inputs against the step's declared schema and
inlines the step's body. `{{ brief.* }}` tokens inside an input value
survive load untouched and resolve at dispatch — so the example above
threads the brief's `change` through the step's `{{ inputs.change }}`.

Inline node bodies remain valid. Pick `uses:` when the body is something
other factories will want to reuse, or when you want a typed input
schema instead of free-form prompt edits. See [[Step]] for the
authoring rules and lookup precedence.

## Templating tokens

A node's `with.prompt` (when a string), `with.base` (when a string) and
`cwd` fields accept template tokens substituted by the runner just before
dispatch. The token grammar
is `{{ <ns>.<field> }}` with optional whitespace inside the braces.

Recognized namespaces:

- `brief.*` — sourced from the [[Brief]] in scope (when one is). Known
  fields: `change`, `body`, `factory`, `base_branch`, `model`. Optional
  fields substitute the empty string when absent; unknown identifiers
  pass through verbatim.
- `run.*` — sourced from the [[Run]]. v0 fields:
  - `run.cwd` — the path of the [[Worktree]] minifac created for this
    run (or `process.cwd()` under `--in-place`).
  - `run.outputs_dir` — absolute path of the per-node-per-iteration
    outputs directory under `~/.minifac/outputs/<run-id>/<node-id>/<iteration>/`.
    The runner creates this directory before dispatch (mkdirp) so the
    executor can write declared [[Outputs]] to it without race. See
    [[Outputs]] for the rest of the contract.
  - `run.base_branch` — the branch the worktree was created from
    (empty string under `--in-place` or for brief-less runs). Useful
    as the default for `minifac:check-merge`'s `base` input.
- `priorResults.<node-id>.outputs.<key>[:read]` — sourced from the
  latest iteration of `<node-id>`'s [[Outputs]]. The no-suffix form
  substitutes the absolute filesystem path; the `:read` suffix inlines
  the file's contents (64 KB cap; throws on oversize or directory
  outputs). Missing prior result or missing key substitutes the empty
  string. Outputs are addressable whether `<node-id>` succeeded or
  failed ([[0041-Failed-Node-Outputs]]).
- `priorResults.<node-id>.status` / `priorResults.<node-id>.reason` —
  the latest iteration's terminal status (`succeeded` | `failed`) and
  recorded reason (empty when `null`; empty when the node has no prior
  result). Lets an `on_failure` target branch on the verdict it was
  reached by.
- `inputs.*` — sourced from the per-node inputs map produced by step
  inlining. Only present on nodes that were inlined from a [[Step]] via
  `uses:`. Strings substitute verbatim; numbers/booleans via
  `String(value)`; arrays/objects via `JSON.stringify(value)`;
  null/undefined and absent optional inputs substitute the empty
  string. Inline nodes have no inputs map, and `{{ inputs.* }}` tokens
  pass through verbatim.
- `node.iteration` — this dispatch's 1-based iteration, the number its
  outputs directory and its events carry (Scarif's worker tags its log
  lines `[node:<id>#<n>]` with it)
  ([[0050-Iteration-Traversal-Tokens]]).
- `edge.traversals` / `edge.max_traversals` — the edge that queued this
  dispatch: how many times it has been taken, counting this traversal,
  and its `max_traversals` budget. A dispatch no edge queued (a start
  node, or a resume seed with no recorded entering edge) renders `0`
  and the empty string; an edge with no budget renders the empty
  string. A pause resume that hands `ParkedRun.via` back as
  `ResumeState.via` renders the counts the parked dispatch would have
  had.

`node.*` and `edge.*` tokens written in a `uses:` node's `inputs:`
survive load-time inlining and resolve at dispatch, so a looping step
can take its pass number and budget as inputs:

```yaml
nodes:
  implement:
    uses: myfac:implement
    start: true
    inputs:
      cycle: "{{ edge.traversals }}"
      max_cycles: "{{ edge.max_traversals }}"   # no hand-kept copy
  review: { uses: myfac:review }
edges:
  - { from: implement, to: review, when: on_success }
  - { from: review, to: implement, when: on_failure, max_traversals: 2 }
```

Unknown `node.*` / `edge.*` fields (e.g. `{{ node.foo }}`) pass through
verbatim with no error, like unknown `brief.*` and `run.*` fields.

Tokens with no resolvable value in the current run pass through
verbatim — the executor sees the literal string. Substitution applies
to `with.prompt`, `with.base` and `cwd`; other node fields are not
touched.

## Bundled built-in steps

minifac ships a small library of built-in steps under
`examples/steps/` that any factory can reference via
`uses: minifac:<name>`:

- `minifac:openspec-propose` / `minifac:openspec-apply` /
  `minifac:openspec-verify` / `minifac:openspec-archive` — the
  four model-driven phases of the [[SDD-Loop]].
- `minifac:check-merge` — a read-only mergeability probe. Checks
  whether `HEAD` would merge cleanly onto a base branch (defaults
  to `{{ run.base_branch }}`) and emits a `succeeded` / `failed`
  status without modifying the worktree. Drop it anywhere in a
  graph — before `apply` for fast-fail, after `archive` to gate
  "done", or anywhere a factory wants a cheap "still mergeable?"
  signal.

  ```yaml
  nodes:
    check-merge:
      uses: minifac:check-merge
      cwd: "{{ run.cwd }}"
      terminal: true
  ```

  The step is read-only and re-entrant; running it multiple times
  in a single graph has no side effects beyond the probe itself.

## Composition

Repos consume factories by referencing them from a [[Brief]]. A brief's
`factory:` field is resolved against `.minifac/factories/<name>.yaml`
first, then falls back to a built-in `minifac:<name>`. Custom factories
can `extends:` a built-in and override per node. See
[[0008-File-Per-Factory-Composition]].

Everything a derived factory omits is inherited from its base, except
`uses_services:` and `needs:`. Those keys are taken only from the file being
loaded; a base's list is never inherited or merged. See
[[0045-Workflow-Uses-Services]] and [[0049-Workflow-Needs]].

The brief's `factory:` is the *default* — it can be overridden at
invocation time with `minifac run <brief> --factory <name>`, which
runs the same resolution precedence against the flag value and
leaves the brief file unchanged. Two A/B invocations of the same
brief through different factories proceed in parallel (the
lockfile key is `(repo-hash, change, factory)`); two through the
same factory still serialize. See
[[0020-Factory-Override-At-Invocation]].

### Worked example: customize SDD's verify step

`minifac init` bootstraps the layout. A consumer repo whose tests run
via `bun test` instead of `npm test` would create
`.minifac/factories/sdd.yaml`:

```yaml
extends: "minifac:sdd"
nodes:
  verify:
    executor: claude
    with:
      prompt: |
        Run `bun test` and report any failures. If tests pass, end
        with `MINIFAC_STATUS: succeeded`. Otherwise end with
        `MINIFAC_STATUS: failed` and a one-line REASON.
      allowed_tools: ["Bash"]
      permission_mode: accept_edits
```

The override redeclares the entire `verify` node — `with.prompt`,
`allowed_tools`, `permission_mode`. Other nodes (`propose`, `apply`,
`archive`) and all `edges:` are inherited from `minifac:sdd`. A brief
whose `factory:` is `sdd` (or `minifac:sdd` to force the built-in)
will run this composed factory.

## Brief-driven vs brief-less

Most factories consume a [[Brief]] (the [[SDD-Loop]] does). Some
factories — nightly drift checks, security triage — don't need per-run
intent and declare `brief: optional | none`. Lookup at invocation time
falls through to the factory name if no brief matches. See
[[0006-Verb-Shape]].

## Schema

A factory file is parsed in two passes. The on-disk shape (accepted by
`FactoryLayerSchema`) may carry an `extends:` key; after chain resolution
and merge the result is validated through `FactorySchema`, which strips
`extends:` and requires `name`, `nodes`, and `edges`.

### Top-level fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string (min 1) | yes (post-merge) | — | Identifier for the factory. Must be non-empty. |
| `description` | string | no | — | Human-readable prose shown in tooling output. |
| `brief` | `"required"` \| `"optional"` \| `"none"` | no | `"required"` | Whether the factory expects a [[Brief]]. `"required"` rejects invocations with no brief; `"optional"` accepts both; `"none"` is for brief-less factories (scheduled tasks, etc.). |
| `extends` | string (min 1) | no | — | Reference to a parent factory. Same resolution precedence as a brief's `factory:` field. Stripped before downstream code sees the factory. Only valid in the on-disk layer; the resolved factory never carries this field. |
| `uses_services` | list of unique, non-empty strings | no | — | Services this workflow's jobs need, by the names the factory repo's `factory.yaml` defines under `services:`. A workflow selects services and never defines one, so a map is refused. minifac carries the list on the resolved factory and ignores it; Scarif acts on it. **Not inherited through `extends:`**: only the loaded file's own key counts. See [[0045-Workflow-Uses-Services]]. |
| `needs` | list of unique, non-empty strings | no | — | Capability tokens this workflow's jobs require of the worker session that runs them, such as `[linux, android]`. Scarif reads the list when a job is ordered and merges it into the job's routing needs; it owns the token vocabulary, so minifac checks the shape only. minifac carries the list on the resolved factory and ignores it. **Not inherited through `extends:`**: only the loaded file's own key counts. See [[0049-Workflow-Needs]]. |
| `nodes` | map of node-id → [[#Node fields\|node]] | yes (post-merge) | — | Keyed by node id (the string you reference in edges). |
| `edges` | array of [[#Edge fields\|edge]] | yes (post-merge) | `[]` | Control-flow declarations. An empty array is valid (single-node factory). |

### Node fields

Each entry under `nodes:` is a map key (the node id) to a node object.
A node uses **either** the inline form (`executor` + `with`) **or** the
step-reference form (`uses` + optional `inputs`). The two forms are
mutually exclusive: the loader refuses a node that declares `uses:`
together with `executor:`, and resolves `uses:` by inlining the step's
`executor` and `with`.

One exception: beside `uses:`, a node MAY declare a `with:` whose **only**
key is `secrets`, a list. The loader copies that list, unchanged, into the
inlined step's `with` as `with.secrets`. This lets a workflow file name the
secrets a library or local step needs, so a reader of the workflow file
alone (Scarif reads `with.secrets` from it) sees them. The loader refuses,
with one sentence naming the node, a `with:` beside `uses:` that holds any
other key, an empty `with: {}`, a `secrets` value that is not a list, and a
node `with.secrets` when the step's own `with` already declares `secrets`:
there is no override and no union. minifac does not check the entries'
shape; the consumer that reads `with.secrets` does. See
[[0046-Uses-Node-Secrets]].

```yaml
nodes:
  implement:
    uses: implement
    with:
      secrets: [STRIPE_KEY, { name: GITHUB_TOKEN, via: proxy }]
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `executor` | string (min 1) | no | — | Which [[Executor]] runs this node. Omit when using `uses:`. The only implemented value is `"claude"`. |
| `with` | map (string → unknown) | no | — | Executor-specific configuration. Shape is validated by the executor at dispatch time, not by the factory loader, except for `executor: command`, whose `with:` the loader also validates ([[0051-Command-Executor]]). See [[#`with:` fields (claude executor)\|with fields]] below. Beside `uses:` it may hold only `secrets` (a list), merged into the inlined step's `with` and refused when the step already declares `secrets`. |
| `uses` | string (min 1) | no | — | Reference to a reusable [[Step]]. Mutually exclusive with `executor`, and with every `with` key except `secrets`. See [[Step#Reference syntax and lookup precedence]]. |
| `inputs` | map (string → unknown) | no | — | Input values supplied to the step declared in `uses:`. Keys must match the step's declared input names. Omit when using inline `executor` + `with`. |
| `cwd` | string | no | — | Working directory for this node. Accepts `{{ run.cwd }}` and `{{ brief.* }}` template tokens. If omitted the runner's default cwd applies. |
| `terminal` | boolean | no | `false` | When `true`, a successful exit from this node ends the run. Use on the last node in a forward-flow path. With `routes:`, the routes apply only on a judged failure, and the loader warns (`terminal_routes`). |
| `start` | boolean | no | — | When `true`, the [[Runner]] dispatches this node when the run begins even though it has inbound edges. Only needed for the entry node of a cycle (e.g. `propose` when `verify → propose` is an `on_failure` edge); a node with no inbound edge from another node starts without it. `false` is the same as omitted. Survives step inlining. See [[0040-Declared-Start-Nodes]]. |
| `max_iterations` | positive integer | no | — | Maximum times this node may be dispatched across the entire run (counting all edge traversals). Absent means unlimited, subject to `max_traversals` on inbound edges. |
| `outputs` | map (string → [[#Output fields\|output]]) | no | — | Declared outputs the node produces (typed JSON values, files, or directories under the per-iteration outputs directory). Keys match the same identifier grammar as step input keys. See [[Outputs]] for the full contract. |
| `resume` | string (min 1) | no | — | Names another node in this factory whose conversation this node continues instead of starting a fresh one. Pair it with a `with.model` override to build a **cascade**: an expensive explore/plan node, then a cheap continuation that already has the context. Validated at load time — see [[#Cross-node session resume\|below]]. Runtime behavior lives in the [[Runner]]. |
| `routes` | list of node ids or `{ to, max_traversals }` | no | — | The nodes this node's result may name as the next to run. The loader synthesizes the node's `next` output from it, so the node may not declare its own `next`. Workflow only: a step file cannot declare it. Survives step inlining. See [[#Node-chosen routing]]. |
| `output_nudge_budget` | non-negative integer | no | `1` | How many in-turn nudge retries the runner MAY use to recover a missing-required-output protocol mistake before recording the node as `failed`. Setting `0` opts the node out of nudging entirely; the missing-outputs override fires on the first validation pass. Per-node only; no factory-level default. The budget is per-node-iteration — a graph-level recovery edge that re-dispatches the same node gets a fresh budget. See [[Outputs#Nudge recovery]] and [[0028-Node-Outputs-Nudge]]. |

### Cross-node session resume

`resume:` points a node at another node's conversation:

```yaml
nodes:
  plan:
    executor: claude
    with:
      prompt: "Explore the repo and plan the change."
  apply:
    executor: claude
    resume: plan          # continue plan's conversation...
    with:
      model: <cheap-model> # ...on a cheaper model
      prompt: "Now implement the plan you just formed."
    terminal: true
edges:
  - from: plan
    to: apply
```

`apply` inherits everything `plan` learned in-context — no plan file,
no re-reading the repo. The model override is the already-existing
`with.model`; `resume:` supplies the other half.

The loader enforces three rules against the resolved factory:

1. the target must be a declared node id;
2. a node may not resume itself (self-chaining across iterations is a
   different feature, deliberately not built);
3. the two nodes' declared `cwd` strings must be identical — sessions
   are scoped per project directory, so a mismatched pair could never
   resolve at run time.

The loader does **not** check that the target actually runs first.
Cycles are first-class, so reachability isn't statically decidable; an
unreachable target fails at dispatch. See [[Runner#Cross-node session
resume]] for the runtime rules, the failure modes, and what happens
across iterations.

### Output fields

Each entry under a node's `outputs:` map is a discriminated union on
`type:` — one of `"value"`, `"file"`, or `"directory"`. Common fields
across all three: `required` (boolean, default `false`) and
`description` (optional string). Per-type fields:

| Type | Extra fields | Storage location | Validation |
|---|---|---|---|
| `value` | `shape` (reserved; ignored today) | `<outputs_dir>/<key>.json` (model-written) | Must exist and parse as JSON when `required: true`. |
| `file` | `filename` (string, no path separators) | `<outputs_dir>/<filename>` or globbed `<key>.*` when filename omitted | Required → exactly one file must match. |
| `directory` | (none) | `<outputs_dir>/<key>/` | Required → directory exists and contains ≥1 file. |

See [[Outputs]] for the runtime contract, template-access syntax, and
the operator surfaces (`runs show --outputs`, `runs cat`,
`prune --outputs`).

### `with:` fields (claude executor)

The `with:` block on a `claude`-executor node (or inside a step that
uses `executor: claude`) is validated by the executor's own `WithSchema`
at dispatch time. The factory loader treats `with:` as an opaque map.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | string (min 1) | yes | — | The instruction text sent to the Claude CLI. Accepts `{{ brief.* }}`, `{{ run.* }}`, and `{{ inputs.* }}` template tokens. The executor auto-appends sentinel-emission instructions unless `emit_sentinel_instructions: false`. |
| `model` | string | no | — | Per-node model override. Maps to `--model <value>` on the Claude CLI. |
| `permission_mode` | `"default"` \| `"accept_edits"` \| `"bypass_permissions"` | no | — | Filesystem authority granted to the spawned Claude session. `"default"` emits no flag (CLI default applies). Maps to `--permission-mode <camelCaseValue>`. |
| `allowed_tools` | string[] | no | — | Allowlist of tool names. Non-empty → `--allowedTools <a,b,c>`. Empty array treated as "emit no flag". |
| `add_dirs` | string[] | no | — | Additional directories the session may read/write beyond `cwd`. Each element → a separate `--add-dir <dir>` flag, in array order. |
| `args` | string[] | no | — | Raw passthrough arguments appended to the Claude CLI invocation after all typed flags. Cannot override typed flags. |
| `emit_sentinel_instructions` | boolean | no | `true` | When `false`, suppresses the auto-appended sentinel-emission instruction block. Response-side sentinel parsing is unaffected. |

### Edge fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `from` | string (min 1) | yes | — | Source node id. Must match a key in `nodes:`. |
| `to` | string (min 1) | yes | — | Destination node id. Must match a key in `nodes:`. |
| `when` | `"on_success"` \| `"on_failure"` \| `"on_error"` \| `{ output, equals }` \| `{ output, in }` | no | `"on_success"` | Condition for traversing this edge. `"on_failure"` edges form recovery paths for a judged failure (e.g. verify → apply retry loop). `"on_error"` edges take a node whose executor could not produce a judgment; a node with none sends its errors along its `"on_failure"` edges instead. When every `"on_error"` edge is budget-exhausted the run ends `budget_exhausted` rather than falling back. See [[0052-On-Error-Edges]]. A mapping is a value condition on one of the `from` node's `type: value` outputs; see [[#Routing on a value]] and [[0055-Value-Edges-And-Node-Routing]]. |
| `max_traversals` | positive integer | no | — | Maximum times this edge may be traversed in a single run. Absent means unlimited. Use to bound [[Cycle]]s. |

### Routing on a value

A value edge tests one of the `from` node's `type: value` outputs. Here is a
three-way verdict:

```yaml
nodes:
  evaluate:
    uses: myfac:evaluate        # writes result.json: { "decision": ... }
  # implement, verify, escalate ...
edges:
  - { from: evaluate, to: verify,    when: { output: result.decision, equals: approve } }
  - { from: evaluate, to: implement, when: { output: result.decision, equals: revise }, max_traversals: 3 }
  - { from: evaluate, to: escalate,  when: { output: result.decision, equals: escalate } }
  - { from: evaluate, to: escalate,  when: on_error }
```

- `output` is an output key, then dotted property names. Arrays are not
  indexed. `equals` takes one JSON scalar and `in` a non-empty list of
  them; a condition has exactly one of the two. Comparison is strict.
- **At load**, the key must be a declared `type: value` output of `from`.
  Step-declared outputs count. When the output has a `schema:`, a path the
  schema rules out (a `false` schema, a non-object `type`, or
  `additionalProperties: false` without the property) and a value outside
  a leaf `enum`/`const` are load errors. Two value edges from one node
  that test the same path with a value in common are a load error naming
  both.
- **At run time**, an error never takes a value edge. On a success or a
  judged failure, every matching value edge is taken in place of the
  outcome's literal edges. Edges on different paths that both match are
  all taken. If none matches, because the value is absent, failed its
  schema or holds another value, the node follows its `on_success` or
  `on_failure` edges, and a `value_edges:` line goes to stderr.
- **Budgets.** A value edge counts against `max_traversals` under the key
  `evaluate->implement:output:result.decision="revise"`, and that count
  survives a park and resume. A matched edge that is exhausted does not
  fall back to the outcome's edges: a failed node then ends the run
  `budget_exhausted`. Cycles closed by value edges need budgets like any
  other ([[Cycle]]).
- The schema's `required` is not demanded. An absent decision just
  matches nothing.

### Node-chosen routing

A node can name its successor itself, from a list it declares
([[0055-Value-Edges-And-Node-Routing]]). `examples/routing.yaml` is a
complete factory:

```yaml
nodes:
  evaluate:
    executor: claude
    max_iterations: 4
    routes: [implement, checks_gate]     # or { to: implement, max_traversals: 2 }
edges:
  - { from: evaluate, to: verify, when: on_success }
  - { from: evaluate, to: implement, when: on_failure }
```

- **The `next` output.** The loader gives a routing node a `type: value`
  output `next`, never required, whose schema is
  `{ enum: [implement, checks_gate, null] }`. The node writes `next.json`
  or calls `mcp__minifac__report_next` (see [[Outputs]]). A routing node
  that declares its own `next` output, or whose step does, is a load
  error. A node without `routes:` may declare `next` freely.
- **At load**, each entry must name a declared node, and its target must
  have a path, along edges of any `when` or other routes, to a
  `terminal: true` node. Either failure is a load error naming the node
  and the entry. Duplicates and `routes: []` are refused. Routes count as
  edges for start nodes and for cycle budgets: a cycle
  closed by a route needs `max_traversals` on the route entry or
  `max_iterations` on a node ([[Cycle]]). Routes are not added to the
  factory's `edges`.
- **At run time**, on a success or a judged failure, a `next` naming a
  route takes that route alone. `null` or no `next` falls through to
  value edges, then outcome edges. A `next` outside `routes` fails the
  node with `output_schema_mismatch: output "next" ...`, and it routes
  `on_failure`. An error ignores `next`. See [[Runner]].
- **Budgets.** A route counts under the key `evaluate->implement:route`.
  A chosen route that is exhausted does not fall back to the other edges:
  a failed node then ends the run `budget_exhausted`, and a succeeded node
  queues nothing, so a run with nothing else queued also ends
  `budget_exhausted`.
- **A terminal routing node.** A `terminal: true` node's success ends the
  run before `next` is read, so its routes are taken only on a judged
  failure. The loader allows it but warns: a `terminal_routes` load
  warning naming the node (`LoadedFactory.warnings`), written and shown
  wherever an `uncovered_cycle` warning is ([[Cycle]]). `strictBudgets`
  does not refuse it.
- **`extends:`.** A layer that redeclares a routing node replaces it whole,
  so it must restate `routes:` to keep them.

Source: `src/factory/schema.ts`, `src/executor/claude.ts`

## Related

- [[Brief]] — per-change input
- [[Runner]] — orchestrator that executes the factory
- [[Executor]] — what runs each node
- [[Cycle]] — bounded recovery loops
- [[0052-On-Error-Edges]] — error vs failure, and `on_error` edges
- [[SDD-Loop]] — canonical example
- [[0004-Factory-vs-Input-Separation]]
- [[0002-Cycles-First-Class]]
