---
status: accepted
date: 2026-08-06
supersedes: []
superseded-by: null
tags: [decision]
---

# 0035: Cross-node session resume

## Context

Every node dispatch is a fresh conversation. A node that explores a
repo, reads twenty files, and forms a plan can only hand its successor
a *lossy artifact* — a plan file, a `value` output, a
[[Sentinel]] REASON string. Everything the model learned but didn't
write down dies at the process boundary, and the next node pays to
rediscover it.

The Claude CLI can continue an existing conversation on a different
model: `claude -p --resume <session-id> --model <other>`. The resumed
turn keeps the session id and the full in-context history, and the
session transcript's per-message `model` fields make split cost
attribution possible. That enables a **cascade**: an explore/plan node
on a large model, then continuation nodes on a cheap model that
already know everything the first node found.

minifac could not express this, and — less obviously — could not have,
because it never captured a session id in the first place. Nothing in
`src/` parsed the CLI's `system` / `init` line, and `runs.db` had no
column for it. The ids scrolled past in raw stream-json stdout
(`src/cli/runs.ts` prefixes each line with `[<nodeId>]`) and were
unrecoverable once the run ended.

Five behaviors were verified against the CLI (v2.1.223) before any
code was written, because the design rests on them:

- `--resume` accepts the prompt on **stdin** under
  `--input-format stream-json`.
- The resumed invocation announces the **same** session id.
- Mid-session stdin writes still work under `--resume`, so the
  [[0028-Node-Outputs-Nudge]] loop composes with it unchanged.
- `--resume` + `--model` is accepted; the transcript's per-message
  `model` fields separate the pre- and post-swap turns.
- `--mcp-config` on a resumed invocation is applied **fresh** — the
  original invocation's servers are not restored.

One surprise from the same session: `system` / `init` is emitted once
per **turn**, not once per process, and is not reliably the first
line. Any capture rule has to be "last announcement wins," not "read
line one."

## Decision

A node MAY declare `resume: <node-id>`, naming another node in the
same factory whose conversation it continues. Combined with the
already-shipped `with.model`, that is the whole cascade surface — no
new model field.

### Surface: node-level, not `with:`, not a step input

`resume:` names a sibling node. That is a topology fact, and it lives
where [[Factory]] keeps topology facts (`terminal`, `max_iterations`,
`cwd`, `outputs`, `output_nudge_budget`).

The decisive argument is [[Step]] reuse. A step is a portable body
inlined into many factories. If `resume` were a `with:` key or a step
input, a shared step would have to be parameterized with a sibling
node's id, every consuming factory would thread it through `inputs:`,
and the [[Executor]] — which has no graph — could validate it only as
a string. On the node, the step body is untouched: any `uses:`-based
node can point at a predecessor without forking the step.

### Load-time validation, three rules

Validated against the **resolved** factory (after `extends:` merge and
step inlining):

1. the target must be a declared node id;
2. a node may not resume itself;
3. the two nodes' declared `cwd` strings must be identical.

Rule 3 is the non-obvious one: sessions are scoped per project
directory, so a session started in one worktree is not resumable from
a node running elsewhere. A mismatch can never resolve at run time, so
it is a load error naming both nodes and both values. Comparison is on
the declared (pre-substitution) string — both nodes normally say
`{{ run.cwd }}`, and resolved values don't exist yet at load.

Reachability is deliberately **not** checked. Per [[0002-Cycles-First-Class]]
the graph is cyclic by design, so "the target always runs first" isn't
statically decidable; an unreachable target fails at dispatch.

### The runner captures the session, not the executor

The [[Runner]] scans each dispatch's stdout for the `system` / `init`
announcement and keeps the last one, storing it on the dispatch's
`NodeResult.session_id` and in `node_executions.session_id`
(schema v4). Parse failures are non-fatal and no event is altered,
suppressed, or reordered — the same posture as the existing
`result`-event scan that drives the nudge loop.

The runner is the right owner for two reasons: it already inspects
stdout line-by-line, and it is the only component holding cross-node
state. The [[Executor]] contract stays exactly what it was — a typed
event stream, no second return channel.

Resolution reuses machinery that already exists: the runner builds a
`nodeId → latest NodeResult` map on every dispatch for prior-results
addressing. The resume resolver is a lookup in that same map, so
"latest dispatch of the named node wins" is not a new rule.

### Iteration semantics: the named node's latest session

On every iteration, a node resumes the session captured for the latest
completed dispatch of the node it **names** — never its own prior
iteration. In a `plan → apply → verify → plan` loop, re-running `plan`
means the next `apply` continues the *new* conversation, which is what
"re-plan, then re-apply" should mean. Self-chaining is a different
feature with different semantics; self-resume is rejected at load so
the syntax stays free for it.

The consequence to internalize: **a session is a mutable log, not a
snapshot.** Resumed turns append to the conversation they resumed and
re-announce its id, so a node resuming twice sees its own earlier
turns the second time. Usually desirable in a revise loop — the second
attempt knows what the first tried — at the cost of context growing
each pass. Two `node_executions` rows may therefore share a
`session_id`; that is the expected shape, not a collision.

### Failure: before spawn, never a silent fallback

The failure that matters is not a crash, it is a *plausible* result.
If the target died to a rate limit and the continuation quietly
started a fresh conversation, a cheap model would produce confident
output with none of the context it was designed around, and nothing in
the run would distinguish that from success.

So an unsatisfiable resume fails the dispatch **before spawning
anything**:

| Reason | Condition |
|---|---|
| `resume_unavailable` (`no_prior_dispatch`) | the target hasn't run in this run |
| `resume_unavailable` (`no_session_captured`) | the target ran but announced no session |
| `resume_unsupported` | the executor declares `supportsResume: false` |

These are ordinary node failures, so `on_failure` edges traverse,
prior results record the reason, and the run terminates per the
existing rules. A session that resolves but turns out unreadable is
*not* one of these — the child exits non-zero and the ordinary
exit-code path applies. minifac never inspects the CLI's session
storage; that layout is a CLI-private detail and coupling to it would
be a durable mistake.

The target's **status** is irrelevant to resolution: a recovery node
on an `on_failure` edge continuing a failed node's conversation is
precisely the useful case.

### Executor capability flag

`supportsResume: boolean` joins `supportsMcp` ([[0029-Node-Outputs-MCP]])
and `supportsNudge` ([[0028-Node-Outputs-Nudge]]) on the executor
interface. The `claude` executor sets it `true` and emits
`--resume <id>` between `--mcp-config` and `--model` — session/context
flags grouped ahead of authority flags, all of them ahead of the
`with.args` passthrough. Nodes without `resume:` produce a
byte-identical argv.

## Consequences

- **Exploration is transferable.** The expensive node explores once;
  continuations inherit it in context. Demonstrated end-to-end: a plan
  node read a config file via a tool call and summarized it, then a
  `resume:` node on a cheap model — forbidden from reading any file —
  wrote exact values from that file to disk.
- **What transfers is the transcript, not the reasoning.** A cascade
  carries what the upstream node actually put into its messages and
  tool calls. A plan node told to "remember" something without saying
  it does not transfer it. Prompt plan nodes to externalize findings.
- **The model swap costs one uncached context transfer.** Swapping
  models invalidates the conversation prompt cache, so the resumed
  turn re-sends the accumulated history at the new model's rate. Still
  cheaper than re-exploring; not free, and the docs say so.
- **Cost attribution becomes possible after the fact.** The
  `session_id` column is the join key from a finished run back to the
  transcript, whose per-message `model` fields split the spend. Storing
  it is what makes the reporting a future choice rather than a lost
  one.
- **`runs.db` is a one-way door at v4.** Migration is additive and
  forward-safe (existing rows keep their values; the new column is
  `NULL`), but a binary older than the database refuses to open it, per
  the existing `MigrationVersionError` contract. Upgrading a shared
  `runs.db` commits every reader of it.
- **Context can grow unboundedly in a resumed cycle.** Accepted for
  v1; see the open question.

## Alternatives considered

- **`with.resume_from` on the claude executor.** Rejected — the
  executor has no factory graph, so a sibling reference could only be
  validated as a string, and shared steps would need to know sibling
  node ids.
- **A step input with a `{{ nodes.<id>.session_id }}` token.**
  Rejected — invents a template namespace and turns a load-time
  checkable reference into a dispatch-time string substitution, which
  is strictly worse for error reporting.
- **Executor returns the session id via a new method or a mid-stream
  typed event.** Rejected — `run()` returns an async iterable and
  nothing else. A second return channel is the premature subsystem the
  anti-goals name; the runner already parses these lines anyway.
- **Iteration N resumes the resuming node's own iteration N-1.**
  Rejected as the default — it makes the declared `resume:` target a
  lie after the first iteration and silently diverges from what the
  operator wrote. Left available as a separate future feature.
- **Fall back to a fresh session when the resume can't be satisfied
  (or a `resume_policy: strict | fallback` knob).** Rejected for v1 —
  the silent-fallback failure mode is confident wrong output that
  reads as success. Strict-only until someone demonstrates a need.
- **Pre-flight check that the session file exists.** Rejected —
  requires hard-coding the CLI's private storage layout. The exit code
  is the contract.
- **Client-side model-id allowlist.** Rejected — model ids change
  faster than this repo ships.
- **Forking the session instead of appending (`--fork-session`).**
  Rejected for v1; see below.

## Open questions

- **Append vs fork.** `--fork-session` exists ("when resuming, create a
  new session ID instead of reusing the original"). v1 appends
  deliberately: the revise loop benefits from seeing its own prior
  attempt, and one id per conversation keeps the cost-attribution join
  simple. A node-level `resume_mode: append | fork` is the obvious
  shape if a factory hits context limits inside a resumed loop. Tracked
  in [[Open-Questions]].
- **Should `session_id` surface in `minifac runs show`?** It is stored
  either way; the display decision can follow the first person who
  needs to pull a transcript.

## Related

- [[0014-Structured-Prior-Results]] — the `NodeResult` shape this
  extends, and the precedent that cross-node context travels as
  structured data rather than raw event history
- [[0028-Node-Outputs-Nudge]] — the mid-session stdin channel that
  `--resume` had to compose with
- [[0029-Node-Outputs-MCP]] — the `supportsMcp` flag this mirrors, and
  the per-dispatch `.mcp.json` that resume does not disturb
- [[0002-Cycles-First-Class]] — why reachability is not validated
- [[0011-SQLite-for-Runs]] — the migration mechanism schema v4 uses
