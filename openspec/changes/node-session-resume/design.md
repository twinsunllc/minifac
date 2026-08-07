## Context

See proposal.md § Why for the motivation. This document pins how the
cascade lands inside the current codebase, and answers the five
questions the shape actually turns on.

Current state, verified against `main` at proposal time:

- **No `--resume` anywhere.** `buildCliArgs` in
  `src/executor/claude.ts` (~L232) emits, in order: the four base
  stream-json flags, `--mcp-config` (when `ctx.mcpConfigPath` is set),
  `--model` (from `with.model`), the authority flags
  (`--permission-mode`, `--allowedTools`, `--add-dir`), then
  `with.args`. The function is snapshot-tested; the argv is an
  explicit wire-format contract.
- **No session id is captured, anywhere.** A repo-wide grep for
  `session_id` / `sessionId` returns nothing outside test fixtures.
  The ids the operator sees in `[<nodeId>] {...}` lines are raw
  stream-json passing through `src/cli/runs.ts` untouched — the
  runner never parses them, `NodeResult` has no field for them, and
  `runs.db` has no column.
- **The runner already parses stdout lines.** `parseTurnFromStdout`
  in `src/runner/run.ts` (~L424) JSON-parses each stdout line looking
  for `type: "result"` to drive the nudge loop's turn boundaries.
  Line-level stream-json inspection in the runner is established
  practice, not a new coupling.
- **`ctx` is the established side-channel.** `RunContext` already
  carries runner-computed, per-dispatch values the executor forwards
  to its CLI (`outputsDir`, `mcpConfigPath`). Capability flags
  (`supportsMcp`, `supportsNudge`) already gate runner behavior per
  executor.
- **`node_executions`** is `(run_id, node_id, iteration, status,
  started_at, ended_at, sentinel_status, exit_code)`, PK
  `(run_id, node_id, iteration)`. Latest migration is
  `0003_add_node_outputs.sql`.
- **Node fields are strict** at both layers: `NodeSchema` in
  `src/factory/schema.ts` is `.strict()`, and `StepSchema` in
  `src/step/schema.ts` is `.strict()` over
  `name/version/description/inputs/executor/with`.

Constraints from `CLAUDE.md`:

- No premature subsystems — resume is a field, a ctx value, a flag,
  and a column. Not a "session manager."
- No anthropomorphic metaphors: `resume`, `session_id`,
  `resume_unavailable`. Not "memory," "handoff," "continuity."
- No DAG-only assumptions — the resolution rule must behave sanely
  when the resume target is re-dispatched by a cycle.
- TypeScript strict; tests next to code; no new runtime dependency.

## Goals / Non-Goals

**Goals:**

- Express a cascade in YAML with one node-level field and the
  already-shipped `with.model`.
- Fail loudly and early when the context a cheap-model node was
  supposed to inherit does not exist.
- Persist the session id so a finished run can be joined to the
  session transcript later (cost attribution is downstream work, but
  it needs this join key or it is impossible after the fact).
- Keep the resume plumbing executor-agnostic in shape: the runner
  resolves *what* session, the executor decides *how* to use it.

**Non-Goals:**

- Reading, parsing, or locating the CLI's session storage. minifac
  passes an id and interprets the exit code. It does not know where
  `~/.claude/projects/...` is, and must not learn.
- Splitting cost by model. This change stores the join key only.
- Any resume that crosses a run boundary or a machine boundary.

## Decisions

### 1. Surface: node-level `resume: <node-id>`, not a step input

**Decision: node-level field.**

A resume declaration names *another node in this factory*. That is a
topology fact, and the node level is where minifac already keeps
topology facts (`terminal`, `max_iterations`, `cwd`, `outputs`,
`output_nudge_budget`). The `factory-schema` capability already
states the rule: node-level fields "describe the node's position in
the graph, not the step's behavior."

The decisive argument is step reuse. A step is a portable body
(`minifac:openspec-apply`) that gets inlined into many factories. If
resume were a step input or a `with:` key, a shared step would have
to be parameterized with a sibling node's id, and every factory
consuming it would have to thread that through `inputs:`. Worse, the
executor would have to validate a graph-level reference it has no
graph to check against. Keeping `resume` on the node means the step
body is untouched: a factory can point *any* `uses:`-based node at a
predecessor's session without forking the step.

How node fields reach dispatch (verified): the loader resolves
`extends:`, inlines steps, validates; `runFactory` then reads the
resolved node object directly (`node.outputs`,
`node.output_nudge_budget`, `node.cwd`) when building the dispatch.
`resume` follows the same path — no new plumbing layer, and it is
preserved verbatim through step inlining on the same independence
basis already specified for `outputs` and `output_nudge_budget`.

*Alternatives considered.* (a) `with.resume_from` on the claude
executor: rejected — the executor has no factory graph, so the
reference could only be validated as a string, and steps would break
as above. (b) A step-level input with `{{ nodes.<id>.session_id }}`
templating: rejected — it invents a new template namespace and moves
a load-time-checkable reference into a dispatch-time string
substitution, which is strictly worse for error reporting.

**Validation is load-time and deliberately narrow:**

- The target must be a declared node id in the *resolved* factory
  (after `extends:` merge and step inlining).
- Self-resume (`resume: <own-id>`) is rejected. Chaining a node onto
  its own previous iteration is a different feature with different
  semantics (see § 3) and is deferred.
- The target's `cwd` string must be identical to the declaring
  node's. This is the non-obvious one: `claude` scopes sessions by
  project directory, so a session started in worktree A is not
  resumable from a node running in directory B. A mismatch is a
  guaranteed runtime miss, so it is a load-time error naming both
  nodes and both `cwd` values. Comparison is on the *declared string*
  (pre-substitution) — both nodes in the common case say
  `{{ run.cwd }}`, and comparing post-substitution values is not
  possible at load.
- Reachability is **not** checked. The graph is cyclic by design;
  "does A always run before B" is not statically decidable, and
  asserting it would violate the no-DAG-assumptions rule. An
  unreachable resume is a runtime failure (§ 4), not a load error.

### 2. Where the session id comes from: the runner scans `system` / `init`

**Decision: the runner parses the session id out of the dispatch's
stream-json stdout and stores it on the `NodeResult`.**

Nothing captures it today, so this is genuinely new. Three placements
were possible:

1. **Runner-side stdout scan (chosen).** The runner already
   JSON-parses every stdout line in `parseTurnFromStdout` to find
   `result` events. A sibling scan for `{"type":"system",
   "subtype":"init","session_id":"..."}` costs one branch in a parse
   that already happens. The runner is also the only component that
   holds cross-node state (`priorResults`), which is where the value
   has to end up. Parse failures stay non-fatal, matching the
   sentinel-detection posture.
2. **Executor emits it on a `status: "started"` event.** Cleaner
   typing, but the executor's event stream is a *typed* contract
   (`stdout | stderr | status | runner-action | runner-nudge`) and
   `status.meta` is deliberately terminal-shaped. Threading a
   mid-stream identity event through it is more surface for the same
   result.
3. **Executor returns it via a new method.** Rejected outright:
   `NodeExecutor.run` returns an async iterable and nothing else. A
   second return channel is the "premature subsystem" the anti-goals
   name.

The captured id lands in two places:

- **`NodeResult.session_id: string | null`** — the run-wide,
  in-memory record the resolver reads. `null` when no init line was
  seen. This extends the same shape that already grew `outputs` and
  `nudges_used`, so `priorResults` remains the single source of
  cross-node truth.
- **`node_executions.session_id`** (schema v4, nullable) — the
  durable join key, written through the existing
  `recordNodeEnd(...)` call with a new optional `sessionId` input.
  Without it, a finished run can never be joined back to its
  transcripts, and the per-message `model` fields that make split
  cost attribution possible are unreachable after the fact.

Resolution at dispatch reuses machinery that already exists: the
runner builds a `priorMap` of `nodeId → latest NodeResult` on every
dispatch (for `{{ priorResults }}` substitution). The resume resolver
is a lookup in that same map, so "latest dispatch of the named node
wins" is not a new rule — it is the rule minifac already uses for
prior-result addressing.

### 3. Iteration semantics: resume the *named node's* latest session

**Decision: on every iteration, node B resumes the session captured
for the latest completed dispatch of the node B names — never B's own
previous iteration.**

`resume:` names a node, and the resolution is "that node's most
recent session." Concretely, in a `plan → apply → verify → apply`
revise loop where `apply` declares `resume: plan`:

- `apply` iteration 1 resumes `plan` iteration 1's session.
- If the cycle re-runs `plan`, `plan` iteration 2 starts a *fresh*
  session (it declares no `resume:`), and `apply` iteration 2 resumes
  that newer session — which is what an operator means by "re-plan,
  then re-apply."
- If the cycle re-runs only `apply`, iteration 2 resumes the same
  `plan` session id as iteration 1.

Rationale: the alternative — "iteration N resumes iteration N-1 of
myself" — is a *different* feature (self-chaining), it makes the
declared target id a lie after the first iteration, and it silently
diverges from the `resume:` value the operator wrote. It is also the
one case where a resume can grow without bound across a long revise
loop. Deferred, as proposal.md states, and self-resume is rejected at
load so the syntax stays free for it.

There is a consequence worth naming precisely, because it is the
sharp edge of this design: **a session is a mutable log, not a
snapshot.** A resumed turn appends to the session it resumed and
reports the *same* session id. So on `apply` iteration 2 resuming
`plan`'s session, the model sees `plan`'s exploration *plus*
`apply` iteration 1's turns. For a revise loop that is usually
desirable — the second attempt knows what the first attempt tried —
but it means:

- Two `node_executions` rows can carry the same `session_id`. That is
  intended; the PK is `(run_id, node_id, iteration)` and the column
  is a join key, not an identity.
- Resumed context accumulates across iterations. A node in a cycle
  with a high `max_iterations` will resume an ever-longer
  conversation. This does not fail — it just costs more.

The CLI does offer a fork-instead-of-append option — `--fork-session`
("when resuming, create a new session ID instead of reusing the
original"), confirmed live (tasks § 1.6). v1 still appends: the
cascade's whole point is that the continuation inherits context, and
a revise loop that also sees its own prior attempt is usually what
the operator wants. `--fork-session` is the named mechanism for a
future `resume_mode: append | fork` knob. The accumulate behavior is
documented in `docs/concepts/Runner.md` and gets a
`docs/Open-Questions.md` entry with the named trigger "a factory hits
context limits inside a resumed revise loop."

### 4. Failure modes: fail before spawn, never fall back silently

The failure that matters is not a crash — it is a *plausible* result.
If node A dies to a 429 and node B silently starts a fresh
conversation on a cheap model, B produces confident output with none
of the context it was designed around, and nothing in the run
distinguishes that from success. So:

| Condition | Behavior |
| --- | --- |
| Target node never dispatched this run | Terminal `failed`, `meta.reason: "resume_unavailable"`, detail `no_prior_dispatch`. **No spawn.** |
| Target dispatched but captured no session (crash before the init line, spawn ENOENT, rate-limit abort) | Terminal `failed`, `meta.reason: "resume_unavailable"`, detail `no_session_captured`. **No spawn.** |
| Resolved executor has `supportsResume: false` | Terminal `failed`, `meta.reason: "resume_unsupported"`. **No spawn.** |
| Session id resolved but the CLI can't find/read the session | The child exits non-zero; the existing exit-code path yields `failed` with `meta.exitCode`. minifac does **not** pre-check the session file. |
| `with.model` names an invalid/unavailable model | Same: non-zero exit, `meta.exitCode`. No client-side model allowlist — model ids change faster than this repo ships. |

Two deliberate choices inside that table:

- **Target failed but produced a session → resume proceeds.** The
  precondition is *a session exists*, not *the node succeeded*. A
  recovery node hanging off an `on_failure` edge resuming the failed
  node's conversation is exactly the useful case; refusing it would
  gut the feature.
- **No pre-flight existence check.** Deriving the session file path
  means hard-coding the CLI's private storage layout. The exit code
  is the contract.

Because these are ordinary node failures, everything downstream works
unchanged: `on_failure` edges traverse, `priorResults` records the
reason, `runs.db` records the node execution, and the run's terminal
reason is `node_failed` per existing semantics.

### 5. Composition with the existing spawn arg set

`--resume` is emitted immediately after `--mcp-config` and *before*
`--model`, keeping session/context flags grouped ahead of the
authority flags and well ahead of the `with.args` passthrough (which
must stay last so it can't override typed flags). The argv snapshot
test picks up the new position deliberately.

Composition, as confirmed live against CLI v2.1.223 before any code
was written (tasks § 1 carries the per-check record):

- **Resume + `--input-format stream-json`.** Confirmed: the resumed
  invocation accepts the prompt on stdin. This was the load-bearing
  assumption of the whole change.
- **Resume + the nudge loop.** Confirmed. The nudge loop writes
  additional user-message frames to the *live child's* stdin between
  `result` events (`run.ts` ~L477–545) and never re-spawns, so it is
  orthogonal to how the conversation was seeded — a probe mirroring
  the loop produced two turns inside one resumed dispatch. Resume
  nodes keep their nudge budget; no narrowing needed.
- **Resume + `--mcp-config`.** Confirmed, and the answer is the
  favorable one: the config passed on the resumed invocation is
  applied fresh, and the original invocation's servers are *not*
  restored. A session started with server `alpha` and resumed with a
  config declaring only `beta` reported `beta` alone. Node B gets
  exactly its own per-dispatch tool set; node A's output tools do not
  leak in. Documentation note only.
- **Resume + `--model` (the cascade itself).** Confirmed end-to-end:
  the swap is accepted, context survives it (a codeword planted on
  the default model was recalled by the resumed cheap-model turn with
  no artifact hand-off), the session id is preserved, and the session
  jsonl's per-message `message.model` + `usage` fields split the
  turns by model — which is what makes cost attribution possible at
  all. The swap invalidates the conversation prompt cache; documented
  in `docs/concepts/Executor.md` so nobody debugs it as a regression.
  Cost model: the resumed turn re-sends the full history uncached at
  the new model's rate, so a cascade pays for context transfer once.
  Cheaper than re-exploring, but not free, and the docs say so.
- **Session id on the resumed dispatch.** Confirmed: the resumed run
  emits an init line carrying the *same* id, so node B's captured
  `session_id` equals node A's. One refinement the probe surfaced —
  `system` / `init` is emitted **once per turn, not once per
  process**: a two-turn dispatch produced two init lines. That makes
  "last init line seen in this dispatch wins" a correctness
  requirement rather than a tie-breaker. Line ordering around it is
  also unstable (a `rate_limit_event` line preceded init on the fresh
  run but not the resumed one), so the scan must not assume init is
  first. The captured value is stored verbatim — no de-duplication,
  no synthesized per-node id.

## Risks / Trade-offs

- **The live checks in tasks § 1 fail (resume doesn't compose with
  stream-json stdin, or with mid-session stdin writes)** → The whole
  design collapses to "resume-only nodes can't nudge." Mitigation:
  § 1 runs *first*, before any code, and the outcome is recorded in
  the tasks file. If mid-session stdin is unavailable under
  `--resume`, the fallback is to require `output_nudge_budget: 0` on
  resume-declaring nodes and say so in the spec — a narrowing, not a
  redesign.
- **Session storage is outside minifac's control** → A user running
  `/clear`, pruning `~/.claude`, or hopping machines mid-run turns a
  resume into a non-zero exit. Mitigation: the failure is loud and
  the exit code is surfaced; minifac makes no durability promise
  about sessions and says so in the docs.
- **Context accumulates across iterations** (§ 3) → A resumed node in
  a long cycle grows its conversation every pass and can eventually
  hit a context limit. Mitigation: documented, with an Open-Questions
  entry and a named trigger for revisiting fork semantics.
- **`cwd`-equality validation is a string compare** → Two nodes whose
  `cwd` strings differ but resolve to the same directory are rejected
  needlessly. Mitigation: accepted. The false-positive is a load
  error with a message naming both values (trivially fixed by the
  author); the false-negative it prevents is a confusing runtime
  miss. Post-substitution comparison isn't available at load time.
- **A cheap continuation node inherits the expensive node's
  authority posture** → the resumed conversation carries A's tool
  history, but B's own `permission_mode` / `allowed_tools` /
  `add_dirs` still come from B's `with:`. No authority is inherited
  through the session; the flags are per-invocation. Called out
  because the opposite is easy to assume.

## Migration Plan

Additive and self-contained:

1. Schema v4 applies on the next `minifac` startup through the
   existing numbered-migration mechanism. Pre-v4 rows read back
   `session_id = null`.
2. Factories that declare no `resume:` are unaffected: identical
   argv (snapshot-verified), identical behavior. The only shape
   change they see is `NodeResult.session_id`, which is populated for
   every dispatch and consumed by nothing unless a `resume:` exists.
3. Rollback is a revert; the added column is nullable and ignored by
   older binaries — though per the `run-storage` capability, a binary
   older than the DB's `schema_version` refuses to open it, so a
   rollback needs the DB reset or restored from before the upgrade.

## Open Questions

- Does the CLI expose a fork-instead-of-append option for a resumed
  session? Answering it doesn't change this change's specs (v1
  appends either way) but decides whether a `resume_mode` knob is
  worth proposing later. Trigger: a factory hits context limits
  inside a resumed revise loop.
- Should `session_id` be surfaced in `minifac runs show` output? It
  is stored either way; the display decision can follow once someone
  actually needs to pull a transcript.
