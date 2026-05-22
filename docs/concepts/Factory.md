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
  `terminal: true` marker, and an optional `max_iterations` budget.
- **Edges** carry `from` / `to` / optional `when` (`on_success` default,
  or `on_failure`) and an optional `max_traversals` budget.
- **Start nodes** are nodes with no `on_success` inbound edge.
  `on_failure` edges are recovery flow, not forward flow, so a node
  whose only inbound is `on_failure` is still a valid entry point.
- **Terminal node** with `terminal: true` ends the run on success.
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

The loader resolves `minifac:openspec-verify` to
`<callerCwd>/examples/steps/openspec-verify.yaml` (built-in form), type-
checks the supplied inputs against the step's declared schema, and
inlines the step's body. `{{ brief.* }}` tokens inside an input value
survive load untouched and resolve at dispatch — so the example above
threads the brief's `change` through the step's `{{ inputs.change }}`.

Inline node bodies remain valid. Pick `uses:` when the body is something
other factories will want to reuse, or when you want a typed input
schema instead of free-form prompt edits. See [[Step]] for the
authoring rules and lookup precedence.

## Templating tokens

A node's `with.prompt` (when a string) and `cwd` fields accept template
tokens substituted by the runner just before dispatch. The token grammar
is `{{ <ns>.<field> }}` with optional whitespace inside the braces.

Recognized namespaces:

- `brief.*` — sourced from the [[Brief]] in scope (when one is). Known
  fields: `change`, `body`, `factory`, `base_branch`, `model`. Optional
  fields substitute the empty string when absent; unknown identifiers
  pass through verbatim.
- `run.*` — sourced from the [[Run]]. Today the only resolved field is
  `run.cwd`, which expands to the path of the [[Worktree]] minifac
  created for this run (or `process.cwd()` under `--in-place`).
- `inputs.*` — sourced from the per-node inputs map produced by step
  inlining. Only present on nodes that were inlined from a [[Step]] via
  `uses:`. Strings substitute verbatim; numbers/booleans via
  `String(value)`; arrays/objects via `JSON.stringify(value)`;
  null/undefined and absent optional inputs substitute the empty
  string. Inline nodes have no inputs map, and `{{ inputs.* }}` tokens
  pass through verbatim.

Tokens with no resolvable value in the current run pass through
verbatim — the executor sees the literal string. Substitution applies
to **both** `with.prompt` and `cwd`; other node fields are not touched.

## Composition

Repos consume factories by referencing them from a [[Brief]]. A brief's
`factory:` field is resolved against `.minifac/factories/<name>.yaml`
first, then falls back to a built-in `minifac:<name>`. Custom factories
can `extends:` a built-in and override per node. See
[[0008-File-Per-Factory-Composition]].

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
| `nodes` | map of node-id → [[#Node fields\|node]] | yes (post-merge) | — | Keyed by node id (the string you reference in edges). |
| `edges` | array of [[#Edge fields\|edge]] | yes (post-merge) | `[]` | Control-flow declarations. An empty array is valid (single-node factory). |

### Node fields

Each entry under `nodes:` is a map key (the node id) to a node object.
A node uses **either** the inline form (`executor` + `with`) **or** the
step-reference form (`uses` + optional `inputs`). The two forms are
mutually exclusive at dispatch: if `uses:` is present the loader resolves
it and inlines the step's `executor` and `with`, discarding any
`executor` or `with` keys on the node itself.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `executor` | string (min 1) | no | — | Which [[Executor]] runs this node. Omit when using `uses:`. The only implemented value is `"claude"`. |
| `with` | map (string → unknown) | no | — | Executor-specific configuration. Shape is validated by the executor at dispatch time, not by the factory loader. See [[#`with:` fields (claude executor)\|with fields]] below. Omit when using `uses:`. |
| `uses` | string (min 1) | no | — | Reference to a reusable [[Step]]. Mutually exclusive with `executor` + `with`. See [[Step#Reference syntax and lookup precedence]]. |
| `inputs` | map (string → unknown) | no | — | Input values supplied to the step declared in `uses:`. Keys must match the step's declared input names. Omit when using inline `executor` + `with`. |
| `cwd` | string | no | — | Working directory for this node. Accepts `{{ run.cwd }}` and `{{ brief.* }}` template tokens. If omitted the runner's default cwd applies. |
| `terminal` | boolean | no | `false` | When `true`, a successful exit from this node ends the run. Use on the last node in a forward-flow path. |
| `max_iterations` | positive integer | no | — | Maximum times this node may be dispatched across the entire run (counting all edge traversals). Absent means unlimited, subject to `max_traversals` on inbound edges. |

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
| `when` | `"on_success"` \| `"on_failure"` | no | `"on_success"` | Condition for traversing this edge. `"on_failure"` edges form recovery paths (e.g. verify → apply retry loop). |
| `max_traversals` | positive integer | no | — | Maximum times this edge may be traversed in a single run. Absent means unlimited. Use to bound [[Cycle]]s. |

Source: `src/factory/schema.ts`, `src/executor/claude.ts`

## Related

- [[Brief]] — per-change input
- [[Runner]] — orchestrator that executes the factory
- [[Executor]] — what runs each node
- [[Cycle]] — bounded recovery loops
- [[SDD-Loop]] — canonical example
- [[0004-Factory-vs-Input-Separation]]
- [[0002-Cycles-First-Class]]
