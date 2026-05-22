# graph-runner Specification

## Purpose
TBD - created by archiving change core-graph-runner. Update Purpose after archive.
## Requirements
### Requirement: Start nodes

The runner SHALL begin execution at every "start node" — defined as a
node with no `on_success` inbound edges. A factory MUST contain at least
one start node; the loader SHALL reject factories with zero. `on_success`
edges represent forward flow; `on_failure` edges represent recovery loops
back into nodes that may have been traversed previously, so a node whose
only inbound edges are `on_failure` is still an entry point for the
forward flow.

#### Scenario: Single start node executes first

- **WHEN** a factory has nodes A, B with edge A → B (`on_success`) and
  the runner begins
- **THEN** node A is scheduled and runs before B

#### Scenario: Multiple start nodes are scheduled together

- **WHEN** a factory has nodes A, B, C with edges A → C and B → C (both
  `on_success`) and the runner begins
- **THEN** A and B are both eligible to run before C

#### Scenario: Cycle entry via on_failure edge is a start node

- **WHEN** a factory has nodes P, V with edges P → V (`on_success`) and
  V → P (`on_failure`)
- **THEN** P is a start node (V's edge back to P is `on_failure`,
  recovery flow, so P has no `on_success` inbound)

#### Scenario: Self-loop on failure does not disqualify a start node

- **WHEN** a factory has node A with edges A → A (`on_failure`) and
  A → T (`on_success`), and T is the only other node
- **THEN** A is a start node

#### Scenario: No start nodes fails at load time

- **WHEN** a factory is constructed such that every node has at least one
  `on_success` inbound edge (e.g. a closed `on_success` loop with no
  entry)
- **THEN** the loader rejects the factory before the runner is invoked

### Requirement: Edge traversal honors `when` condition

When a node completes, the runner SHALL evaluate each outbound edge's
`when` condition against the node's outcome and traverse only matching
edges. An edge with `when: "on_success"` (default) traverses only when
the source node reports a `succeeded` status; `when: "on_failure"`
traverses only on `failed`.

#### Scenario: Failed node does not traverse default edges

- **WHEN** node A fails and has a single outbound edge A → B with no
  explicit `when`
- **THEN** B is not scheduled

#### Scenario: Failed node traverses an on_failure edge

- **WHEN** node A fails and has an outbound edge A → R with
  `when: "on_failure"`
- **THEN** R is scheduled

### Requirement: Cycle budgets are enforced at runtime

The runner SHALL track edge traversal counts and node execution counts.
When traversing an edge would exceed its `max_traversals`, the edge is
skipped. When scheduling a node would exceed its `max_iterations`, the
node is not scheduled.

#### Scenario: Edge budget halts a retry loop

- **WHEN** edge V → P has `max_traversals: 2` and V → P has already been
  traversed twice
- **THEN** a third attempt to traverse V → P does not schedule P

#### Scenario: Node budget halts repeated execution

- **WHEN** node P has `max_iterations: 3` and has already executed three
  times
- **THEN** subsequent attempts to schedule P are skipped

### Requirement: Run termination

A run SHALL end with status `succeeded` when a terminal node completes
with status `succeeded`. A run SHALL end with status `failed` when:
(a) a node fails and no outbound `on_failure` edges remain traversable,
(b) all relevant cycle budgets are exhausted before any terminal node
succeeds, or (c) the graph drains (no node is eligible to run) without a
successful terminal node.

#### Scenario: Terminal node completion ends the run

- **WHEN** a node with `terminal: true` completes with `succeeded`
- **THEN** the runner stops scheduling new nodes and returns a
  `succeeded` run result, even if other nodes were still eligible

#### Scenario: Budget exhaustion ends the run as failed

- **WHEN** the only path to a terminal node passes through an edge whose
  `max_traversals` budget has been exhausted
- **THEN** the runner returns a `failed` run result with a reason that
  identifies budget exhaustion

#### Scenario: Terminal node may participate in a cycle

- **WHEN** a terminal node V is reached via a cycle (e.g. V loops back
  to P on failure, terminates on success) and V succeeds on the second
  iteration
- **THEN** the runner ends with `succeeded`, having traversed the cycle
  once

### Requirement: Streaming node events

While a node is executing, the runner SHALL forward every event yielded
by that node's executor (`stdout`, `stderr`, `status`) to a consumer
provided at run invocation, in order, without buffering beyond what is
necessary to deliver one event at a time.

#### Scenario: Consumer sees events as they arrive

- **WHEN** an executor yields three `stdout` events spaced 100ms apart
- **THEN** the consumer receives them in order, each within a small
  constant of the time the executor yielded it (no batching at end of run)

### Requirement: Run result is structured

When a run ends, the runner SHALL return a structured result containing:
overall status (`succeeded` | `failed`), the reason for termination, the
sequence of nodes that executed (with per-node status and counts), and
the total run duration.

#### Scenario: Failed run result names the failed node

- **WHEN** node P fails and no recovery edge is available
- **THEN** the run result has `status: "failed"` and a reason that
  identifies P as the failing node

### Requirement: Brief token substitution before node dispatch

The runner SHALL accept an optional `brief` argument identifying the
brief that initiated the run and an optional `runCwd` argument
carrying the run-level cwd (see the "Run-level cwd resolution"
requirement). The runner SHALL ALSO accept an optional
`runBaseBranch` argument carrying the run's configured base branch
(the branch the worktree was created from, per the
`worktree-management` capability). Together with the per-node inputs
map produced by step inlining (see the `factory-schema` capability's
"Step inlining order" and "Step input validation" requirements),
these form the substitution namespaces the runner offers to each
scheduled node.

For each scheduled node, immediately before dispatching to the
node's executor, the runner SHALL substitute template tokens in
both:

- the node's `with.prompt` field (if and only if it is a string), and
- the node's `cwd` field (if and only if it is a non-empty string), and
- the node's `with.base` field (if and only if it is a string),
  for the benefit of the `check-merge` executor and any future
  executor whose `with:` schema names a string field whose contents
  may carry brief/run/inputs tokens. The runner SHALL apply the
  same substitution grammar to `with.base` as to `with.prompt`.

The token grammar SHALL be: literal `{{`, optional ASCII whitespace,
a namespace identifier (`brief`, `run`, or `inputs`), literal `.`, a
field identifier matching `[a-zA-Z_][a-zA-Z0-9_]*`, optional ASCII
whitespace, literal `}}`. The runner SHALL match this grammar
globally across each target string.

Field resolution rules per matched token:

- `brief.change`, `brief.body`, `brief.factory`: substitute the
  corresponding string value from the resolved brief. These fields
  are always present on a resolved brief.
- `brief.base_branch`, `brief.model`: substitute the string value if
  present on the brief; otherwise substitute the empty string.
- `run.cwd`: substitute the run's `runCwd` value (the worktree path
  or the in-place cwd, as supplied by the CLI) when `runCwd` is in
  scope; otherwise leave the token verbatim.
- `run.base_branch`: substitute the run's `runBaseBranch` value (the
  branch the worktree was created from, per the
  `worktree-management` capability) when `runBaseBranch` is in
  scope and is a non-empty string; substitute the empty string
  when `runBaseBranch` is in scope but is the empty string (in-
  place / brief-less / no-base runs); leave the token verbatim
  when `runBaseBranch` is not in scope at all (e.g. a unit-test
  invocation of `runFactory` that does not supply it).
- `inputs.<field>`: substitute the corresponding value from the
  per-node inputs map produced by step inlining. When the value is
  a string, substitute it verbatim. When the value is a number,
  boolean, array, or object, substitute its `String(value)` form
  (numbers and booleans stringify to their natural string
  representations; arrays and objects stringify via
  `JSON.stringify` so the executor receives a deterministic
  textual form). When the node has no `inputs` map in scope (the
  node was not inlined from a step), `inputs.*` tokens SHALL be
  left verbatim. When the node has an inputs map but the named
  field is absent (optional input with no default and no node
  supply), the token SHALL substitute the empty string. When the
  node has an inputs map and the named field is present but its
  value is `null` or `undefined`, the token SHALL substitute the
  empty string.
- For any other identifier under a known namespace (e.g.
  `brief.depends_on`, `run.id`): leave the token verbatim in the
  string (no error, no substitution).
- For any token whose namespace is not `brief`, `run`, or `inputs`:
  leave the token verbatim in the string.

When the run has no brief, `brief.*` tokens SHALL be left verbatim.
When the run has no `runCwd` in scope (e.g. a unit-test invocation
of `runFactory` without the CLI sequencing wrapper), `run.cwd`
tokens SHALL be left verbatim. When the run has no `runBaseBranch`
in scope, `run.base_branch` tokens SHALL be left verbatim (matching
`run.cwd`'s convention). When the node has no inputs map (inline
node, not produced by step inlining), `inputs.*` tokens SHALL be
left verbatim.

Substitution SHALL happen in the runner, not in the executor. The
executor sees the resolved strings with no tokens (when the relevant
namespace is in scope) or the verbatim string (when not). The
executor interface and its `with:` validation are unchanged by this
requirement.

#### Scenario: `{{ brief.change }}` substitutes the change name

- **WHEN** a node's `with.prompt` is
  `"Work on change {{ brief.change }}."` and the run's brief has
  `change: "foo"`
- **THEN** the executor receives `with.prompt` equal to
  `"Work on change foo."`

#### Scenario: `{{ brief.body }}` substitutes the brief body verbatim

- **WHEN** a node's `with.prompt` is
  `"## Intent\n\n{{ brief.body }}"` and the run's brief has body
  `"Make X happen.\nPlease."`
- **THEN** the executor receives `with.prompt` equal to
  `"## Intent\n\nMake X happen.\nPlease."`

#### Scenario: Missing optional field substitutes empty string

- **WHEN** a node's `with.prompt` is
  `"Base branch: {{ brief.base_branch }}."` and the run's brief omits
  `base_branch`
- **THEN** the executor receives `with.prompt` equal to
  `"Base branch: ."`

#### Scenario: Unknown identifier passes through verbatim

- **WHEN** a node's `with.prompt` is
  `"Future field: {{ brief.depends_on }}."` and the run has any brief
- **THEN** the executor receives `with.prompt` equal to
  `"Future field: {{ brief.depends_on }}."` (verbatim, no error)

#### Scenario: Tokenless prompt is unchanged

- **WHEN** a node's `with.prompt` is
  `"Say hello in one sentence."` and the run has a brief
- **THEN** the executor receives `with.prompt` equal to
  `"Say hello in one sentence."` (byte-identical)

#### Scenario: Brief-less run leaves brief tokens verbatim

- **WHEN** a node's `with.prompt` contains `{{ brief.change }}` and
  the run has no brief in scope (brief-less factory invocation)
- **THEN** the executor receives `with.prompt` with the token preserved
  verbatim; the executor's existing validation behavior applies to the
  unchanged string

#### Scenario: Non-string `with.prompt` is left alone

- **WHEN** a node's `with.prompt` is not a string (or the node has no
  `with.prompt` at all)
- **THEN** the runner performs no substitution on that node's
  `with.prompt`; the executor's existing `with:` validation applies
  as today

#### Scenario: `{{ run.cwd }}` substitutes in the cwd field

- **WHEN** a node's `cwd` is `"{{ run.cwd }}"` and the runner's
  `runCwd` is `/Users/x/.minifac/worktrees/abcd-foo`
- **THEN** the executor receives `cwd` equal to
  `"/Users/x/.minifac/worktrees/abcd-foo"`

#### Scenario: `{{ run.cwd }}` substitutes inside `with.prompt` too

- **WHEN** a node's `with.prompt` is
  `"Working directory: {{ run.cwd }}."` and the runner's `runCwd`
  is `/tmp/wt`
- **THEN** the executor receives `with.prompt` equal to
  `"Working directory: /tmp/wt."`

#### Scenario: `{{ run.cwd }}` with no runCwd in scope passes through

- **WHEN** a node's `cwd` is `"{{ run.cwd }}"` and the runner was
  invoked without a `runCwd` argument
- **THEN** the substitution pass leaves the field as
  `"{{ run.cwd }}"` and the default-cwd fallback (per the
  "Run-level cwd resolution" requirement) determines what the
  executor receives

#### Scenario: Unknown `run.*` field passes through verbatim

- **WHEN** a node's `with.prompt` is
  `"Run id: {{ run.id }}."` and the runner's `runCwd` is set
- **THEN** the executor receives `with.prompt` equal to
  `"Run id: {{ run.id }}."` (verbatim, no error)

#### Scenario: `{{ run.base_branch }}` substitutes in `with.base`

- **WHEN** a node's `with.base` is `"{{ run.base_branch }}"` and the
  runner's `runBaseBranch` is `"main"`
- **THEN** the executor receives `with.base` equal to `"main"`

#### Scenario: `{{ run.base_branch }}` substitutes inside `with.prompt`

- **WHEN** a node's `with.prompt` is
  `"Probing against {{ run.base_branch }}."` and the runner's
  `runBaseBranch` is `"develop"`
- **THEN** the executor receives `with.prompt` equal to
  `"Probing against develop."`

#### Scenario: `{{ run.base_branch }}` with empty runBaseBranch substitutes empty string

- **WHEN** a node's `with.base` is `"{{ run.base_branch }}"` and the
  runner was invoked with `runBaseBranch: ""` (in-place run, or
  run from a non-worktree base)
- **THEN** the substitution pass replaces the token with the empty
  string, and `with.base` arrives at the executor as the empty
  string (the executor's own `with:` validation determines whether
  this is acceptable)

#### Scenario: `{{ run.base_branch }}` with no runBaseBranch in scope passes through

- **WHEN** a node's `with.base` is `"{{ run.base_branch }}"` and the
  runner was invoked without a `runBaseBranch` argument at all
  (e.g. a unit test of `runFactory` that supplies neither)
- **THEN** the substitution pass leaves the field verbatim as
  `"{{ run.base_branch }}"`; the executor's existing `with:`
  validation applies to the unchanged string

#### Scenario: `{{ inputs.<field> }}` substitutes a string input value

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { change: "foo" }`, and the node's `with.prompt` (sourced
  from the step body) is `"Work on {{ inputs.change }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Work on foo."`

#### Scenario: `{{ inputs.<field> }}` stringifies a number

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { iterations: 3 }`, and the node's `with.prompt` is
  `"Run {{ inputs.iterations }} times."`
- **THEN** the executor receives `with.prompt` equal to
  `"Run 3 times."`

#### Scenario: `{{ inputs.<field> }}` stringifies a boolean

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { dry_run: true }`, and the node's `with.prompt` is
  `"Dry run: {{ inputs.dry_run }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Dry run: true."`

#### Scenario: `{{ inputs.<field> }}` stringifies an array as JSON

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { commands: ["npm test", "npm run build"] }`, and the
  node's `with.prompt` is `"Commands: {{ inputs.commands }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Commands: [\"npm test\",\"npm run build\"]."`

#### Scenario: `{{ inputs.<field> }}` with an absent optional input substitutes empty string

- **WHEN** a node was inlined from a step that declares
  `model: { type: "string" }` (optional, no default) and the
  factory's node-level `inputs:` did not supply `model`, and the
  node's `with.prompt` is `"Model: {{ inputs.model }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Model: ."`

#### Scenario: `{{ inputs.<field> }}` on an inline node passes through verbatim

- **WHEN** a node was NOT inlined from a step (declared inline
  `executor:` + `with:`) and the node's `with.prompt` is
  `"Foo: {{ inputs.bar }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Foo: {{ inputs.bar }}."` (verbatim, no error)

#### Scenario: `{{ inputs.<field> }}` and `{{ brief.<field> }}` cooperate

- **WHEN** a factory node declares `uses: minifac:openspec-propose`
  with `inputs: { change: "{{ brief.change }}" }`, and the step's
  body contains `"Work on {{ inputs.change }}."`, and the run's
  brief has `change: "foo"`
- **THEN** at load time the step is inlined with the input value
  preserved as the literal token string `"{{ brief.change }}"`
  (since the brief is not in scope at load); at dispatch time the
  runner first substitutes `{{ inputs.change }}` to the literal
  `"{{ brief.change }}"`, then a subsequent pass substitutes
  `{{ brief.change }}` to `"foo"`; the executor receives
  `with.prompt` equal to `"Work on foo."`

#### Scenario: Inputs substitution preserves null/undefined values as empty string

- **WHEN** a node was inlined from a step whose factory supplied
  `inputs: { note: null }` (explicit null) and the node's
  `with.prompt` is `"Note: {{ inputs.note }}."`
- **THEN** the executor receives `with.prompt` equal to
  `"Note: ."`

### Requirement: Run-level cwd resolution

The runner SHALL accept an optional `runCwd` argument. When
`runCwd` is supplied, it SHALL be used as the default cwd for any
scheduled node whose `cwd` field is absent, or whose `cwd` field
resolves to the empty string after substitution.

Resolution order, per node, performed by the runner immediately
before dispatching the node to its executor:

1. Apply template substitution to the node's `cwd` field (if a
   non-empty string). The result is the candidate cwd.
2. If the candidate is a non-empty string, that string is the
   resolved cwd passed to the executor.
3. Otherwise, if `runCwd` is in scope (non-empty), the resolved
   cwd is `runCwd`.
4. Otherwise, the resolved cwd is `undefined` (today's behavior
   when no cwd is supplied; executors interpret per their own
   contract).

When `runCwd` is not supplied (e.g. unit-test invocations of
`runFactory`), step 3 is skipped and the runner's behavior reduces
to today's contract: the executor receives whatever the factory
declared, including `undefined` for nodes that declare no `cwd`.

#### Scenario: Node with literal cwd keeps it

- **WHEN** a node declares `cwd: "/explicit/path"` and the runner
  has `runCwd: "/wt"`
- **THEN** the executor receives `cwd` equal to `"/explicit/path"`
  (the literal value takes precedence over the run-level default)

#### Scenario: Node with `{{ run.cwd }}` token resolves to runCwd

- **WHEN** a node declares `cwd: "{{ run.cwd }}"` and the runner
  has `runCwd: "/wt"`
- **THEN** the executor receives `cwd` equal to `"/wt"`

#### Scenario: Node with no cwd uses runCwd as default

- **WHEN** a node declares no `cwd` field at all and the runner
  has `runCwd: "/wt"`
- **THEN** the executor receives `cwd` equal to `"/wt"`

#### Scenario: Empty-string cwd uses runCwd as default

- **WHEN** a node declares `cwd: ""` (or a cwd value that
  substitutes to the empty string) and the runner has
  `runCwd: "/wt"`
- **THEN** the executor receives `cwd` equal to `"/wt"`

#### Scenario: No runCwd in scope reproduces today's behavior

- **WHEN** the runner is invoked without `runCwd` and a node has
  no `cwd` field
- **THEN** the executor receives `cwd` as `undefined` (the
  pre-this-change default)

### Requirement: Optional `RunStore` persistence

The runner SHALL accept an optional `store` argument implementing
the `run-storage` capability's `RunStore` interface. When `store`
is provided, the runner SHALL persist run state and events
through it; when `store` is absent, the runner SHALL behave
exactly as it does today (used by unit tests and any caller that
doesn't care about persistence).

When a `store` is in scope, the runner SHALL:

1. Immediately before the first node is dispatched, generate a
   run id and invoke `store.createRun(...)` with the run's
   starting metadata. The metadata SHALL include at minimum:
   the factory's absolute path, the factory's declared `name`,
   the brief's source path and `change` (when a brief is in
   scope), the `runCwd` value (as `worktreePath` for worktree-
   mode runs and as `null` when no `runCwd` is set), the
   `base_branch` from the brief (when present), and the run's
   `startedAt` epoch-ms timestamp.
2. For every event the runner records into run-wide history, in
   the same order, invoke `store.appendEvent(runId, ...)`. The
   in-memory history and the durable event log SHALL stay
   structurally consistent; the runner SHALL NOT drop events
   from one and keep them in the other.
3. Bracket each node dispatch with `store.recordNodeStart(...)`
   before the executor is invoked and `store.recordNodeEnd(...)`
   after the node terminates (including when the node is skipped
   for budget reasons).
4. When the run terminates (success, failure, or budget
   exhaustion), invoke `store.finalizeRun(runId, ...)` with the
   terminal status, reason, proximate node id (when known), and
   the `endedAt` epoch-ms timestamp.

Store calls SHALL NOT swallow runner-fatal errors but SHALL NOT
themselves abort the run on transient persistence failures; a
store-level error SHALL be surfaced to the caller via the run's
emitted events (a synthetic `stderr` line) so the run still
completes the in-memory contract. The exact failure semantics
of the v0 SQLite adapter (transactions per-row, retries) are
specified in the `run-storage` capability.

#### Scenario: Run without a store behaves identically to today

- **WHEN** `runFactory(...)` is invoked without a `store` argument
  on a factory that succeeds today
- **THEN** the run completes with the same `RunResult` it does
  today; no persistence call is attempted

#### Scenario: Store is created at the start, finalized at the end

- **WHEN** `runFactory(loaded, { store, brief, runCwd, ... })`
  is invoked and the run reaches a terminal node `succeeded`
- **THEN** `store.createRun` is called exactly once before the
  first node dispatch (with the brief's `change` set on the
  stored run), `store.appendEvent` is called once per emitted
  event in order, and `store.finalizeRun` is called exactly
  once with `status: "succeeded"` after the terminal node
  completes

#### Scenario: Stored event seq matches in-memory history order

- **WHEN** a run emits five events
- **THEN** the store's `getRunEvents(runId)` returns those five
  events with `seq` values `0, 1, 2, 3, 4` in the same order
  the runner's `onEvent` consumer saw them

#### Scenario: Brief-less run records null brief / change

- **WHEN** a brief-less factory invocation runs with a store in
  scope
- **THEN** the stored run's `briefPath` and `change` are both
  `null`; `factoryName` is still populated from the factory's
  declared `name`

#### Scenario: Failed run finalizes with structured reason

- **WHEN** a run terminates `failed` with reason
  `budget_exhausted` and proximate node `verify`
- **THEN** `store.finalizeRun` is invoked with
  `status: "failed"`, `reason: "budget_exhausted"`,
  `proximateNodeId: "verify"`, and an `endedAt` timestamp;
  the corresponding stored run row reflects those values

### Requirement: Prior-results accumulate across node executions

The runner SHALL maintain an ordered, run-wide array of structured
`NodeResult` entries — one entry per completed node execution,
appended in completion order at the moment the executor's event
stream drains and the node's terminal status is resolved. Each
entry SHALL have exactly the following shape:

```ts
{
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  reason: string | null;   // sentinel REASON when failed; null otherwise
  startedAt: number;       // ms since run start
  endedAt: number;         // ms since run start
}
```

When a node is scheduled, the runner SHALL pass a read-only,
frozen snapshot of the `priorResults` array through the executor's
run context as `ctx.priorResults`. Subsequent iterations of the
same node in a cycle SHALL therefore receive their own prior
result entries (and the entries of every other node that ran in
between).

The `reason` field SHALL be populated from the executor's terminal
`status` event `meta` payload: when `meta.reason === "sentinel_failed"`
and `meta.sentinel` is a string, `reason` SHALL be that string
(trimmed of trailing whitespace). In all other cases (successful
executions, non-sentinel failures), `reason` SHALL be `null`.

Skipped nodes (those that hit the `max_iterations` budget at pop
time and were not actually dispatched to an executor) SHALL NOT
contribute an entry to `priorResults`.

The runner SHALL NOT pass the raw per-event run history through
the run context. The `onEvent` streaming consumer SHALL continue
to receive every event in real time, unchanged.

#### Scenario: Prior-results accumulate across nodes

- **WHEN** node A runs and completes with `succeeded` after
  emitting two stdout events, then node B is scheduled
- **THEN** the run context passed to B contains `priorResults`
  with exactly one entry: `{ nodeId: "A", iteration: 1,
  status: "succeeded", reason: null, startedAt: <ms>,
  endedAt: <ms> }`

#### Scenario: A node's second iteration sees its first iteration's result

- **WHEN** node P runs (iteration 1) and succeeds, then node V
  runs and fails with a sentinel REASON of `"verify hit error"`,
  then the runner cycles back to P for iteration 2
- **THEN** the run context passed to P on iteration 2 contains
  `priorResults` with two entries in order: P iter 1 (status
  `succeeded`, `reason: null`), then V iter 1 (status `failed`,
  `reason: "verify hit error"`)

#### Scenario: Prior-results snapshot is stable for the duration of a node run

- **WHEN** node A is running and node B (running concurrently in
  a future fan-out) completes
- **THEN** A's `priorResults` snapshot does not change mid-run;
  A sees only the entries that existed when it was scheduled.
  (v0 is single-flight, so this is trivially true; the rule is
  documented to bind future fan-out.)

#### Scenario: Non-sentinel failure records null reason

- **WHEN** a node fails via non-zero exit code with no
  `MINIFAC_STATUS:` sentinel in the final result event
- **THEN** the entry appended to `priorResults` has `status:
  "failed"` and `reason: null`

#### Scenario: Skipped node is not appended

- **WHEN** node P has `max_iterations: 2` and has already
  executed twice, and the runner pops a third scheduled
  occurrence of P from its queue
- **THEN** the runner skips P without dispatch and SHALL NOT
  append a `priorResults` entry for that skipped occurrence

