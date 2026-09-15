## Why

Today every node dispatch is a fresh `claude` conversation. A node
that explores a codebase, reads twenty files, and forms a plan can
only hand its successor a *lossy artifact* — a plan file, a `value`
output, a prior-results `reason` string. Everything the model learned
but didn't write down is thrown away at the process boundary.

The `claude` CLI can continue an existing conversation on a different
model: `claude -p --resume <session-id> --model <other-model>`. The
resumed turn keeps the session id and the full in-context history,
and the session's per-message `model` fields make split cost
attribution possible. That unlocks a **cascade**: an explore/plan node
on a large model, then one or more continuation nodes on a cheap model
that already know everything the first node found — no artifact
round-trip, no re-reading the repo.

minifac cannot express this. It never passes `--resume`, and it never
captures a session id in the first place: nothing in `src/` parses the
CLI's `system` / `init` line, and `runs.db` has no column for it. The
session ids scroll past in raw stream-json stdout and are lost when
the run ends.

## What Changes

- **NEW** node-level `resume: <node-id>` field on the factory schema.
  Declares that this node continues the named node's most recent
  conversation instead of starting a fresh one. Topology, not
  executor payload — so it lives beside `terminal` / `max_iterations`
  / `cwd`, survives step inlining, and stays out of `with:` (a
  reusable step must not need to know a sibling node's id).
- **NEW** session-id capture in the runner. The runner scans each
  dispatch's stream-json stdout for the `system` / `init` line's
  `session_id` and records it on the dispatch's `NodeResult` as a new
  `session_id` field.
- **NEW** `ctx.resumeSessionId` on the executor run context. The
  runner resolves `resume: <node-id>` against the session id captured
  for that node's latest completed dispatch and threads it through —
  the same shape already used for `ctx.mcpConfigPath`.
- **NEW** `supportsResume` capability flag on the `NodeExecutor`
  interface, mirroring `supportsMcp` / `supportsNudge`. The `claude`
  executor sets it `true`; a resume-declaring node routed to an
  executor that sets it `false` fails before spawn.
- **NEW** `--resume <session-id>` in the `claude` executor's argv,
  emitted when `ctx.resumeSessionId` is in scope, ahead of `--model`
  and every node-supplied flag.
- **NEW** `resume_unavailable` / `resume_unsupported` terminal
  failure reasons. A node whose resume target produced no session
  (crash, rate-limit, never dispatched) fails **before spawn** rather
  than silently starting a fresh, context-free conversation on a
  cheap model.
- **NEW** load-time validation: the target must be a declared node,
  must not be the declaring node itself, and must declare a `cwd`
  string identical to the declaring node's — `claude` scopes sessions
  per project directory, so a cwd mismatch is a guaranteed runtime
  miss and is worth catching at load.
- **NEW** `runs.db` schema v4: `node_executions.session_id`, so a
  finished run can be joined back to the session transcript for cost
  attribution and postmortems.
- **MODIFIED** `NodeResult` shape — gains `session_id: string | null`
  alongside the existing `outputs` and `nudges_used` fields.
- **MODIFIED** the two `factory-schema` requirements that enumerate
  the strict node-level key set. They currently disagree with each
  other (`Node definition` lists `outputs` and `output_nudge_budget`;
  `Node uses: field...` does not). Both are restated with the full
  set plus `resume`.
- **No new model field.** The "override the model" half of the
  cascade is already shipped: `with.model` → `--model`. `--resume`
  and `--model` compose on one argv.

Explicitly **out of scope** (deferred):

- Resuming a node's *own* prior iteration (`resume: <self>`), and any
  resume across runs or across machines.
- A `resume_policy: strict | fallback` knob that would let a node
  start fresh when the session is missing. v1 is strict-only.
- Forking a session instead of appending to it (see design.md
  § "Iteration semantics" — the accumulate behavior is deliberate for
  v1 and gets an Open-Questions entry).
- Cost attribution *reporting* (splitting a run's spend by model from
  the session transcript). This change only persists the join key.
- Pre-flight existence checks on the CLI's session storage. The
  on-disk layout is a CLI-private detail; minifac SHALL NOT couple
  to it.

## Capabilities

### New Capabilities

(none — this extends four existing capabilities)

### Modified Capabilities

- `factory-schema`: adds the node-level `resume:` field, its
  validation rules (declared target, no self-resume, matching `cwd`),
  and its preservation through step inlining; restates the two
  requirements that enumerate the strict node-level key set.
- `graph-runner`: adds per-dispatch session-id capture, the
  `resume:` → `ctx.resumeSessionId` resolution rule (including the
  pre-spawn failure paths), and extends the `NodeResult` shape with
  `session_id`.
- `node-executor`: adds the `supportsResume` capability flag and
  extends the `claude` executor's argv contract with `--resume`.
- `run-storage`: adds schema v4 (`node_executions.session_id`) and
  the `recordNodeEnd` input field that populates it.

## Impact

- **Affected specs**:
  - `factory-schema` (MODIFIED): `Node definition`,
    `Node uses: field as an alternative to inline executor`;
    ADDED `Node resume: field`.
  - `graph-runner` (MODIFIED): `Prior-results accumulate across node
    executions`; ADDED `Per-dispatch session id capture` and
    `Cross-node session resume resolution`.
  - `node-executor` (MODIFIED): `Claude executor uses stream-json for
    both input and output`; ADDED `Executor supportsResume capability
    flag`.
  - `run-storage` (ADDED): `Schema v4 adds session_id to
    node_executions`.

- **Affected code**:
  - `src/factory/schema.ts`: `resume` on `NodeSchema` (strict key
    set), and the post-schema validation pass that resolves the
    target id / rejects self-resume / compares `cwd`.
  - `src/factory/loader.ts` (or wherever post-schema validation and
    step inlining live): preserve `resume` through inlining; run the
    new validation against the resolved factory.
  - `src/executor/types.ts`: `resumeSessionId?: string` on
    `RunContext`; `supportsResume: boolean` on `NodeExecutor`;
    `session_id: string | null` on `NodeResult`.
  - `src/executor/claude.ts`: `supportsResume = true`;
    `buildCliArgs(w, mcpConfigPath, resumeSessionId)` emits
    `--resume` ahead of `--model`; wire-format comment block updated.
  - `src/runner/run.ts`: session-id scan alongside the existing
    `parseTurnFromStdout` stdout inspection; resume resolution before
    dispatch; pre-spawn failure paths; `session_id` on the pushed
    `NodeResult`; `sessionId` passed to `recordNodeEnd`.
  - `src/storage/migrations/0004_add_session_id.sql` +
    `src/storage/migrations/index.ts`; `RecordNodeEndInput.sessionId`
    in `src/storage/run-store.ts`; the UPDATE in
    `src/storage/sqlite.ts`.
  - Tests next to each of the above.

- **Affected docs**:
  - `docs/concepts/Factory.md`: the `resume:` node field.
  - `docs/concepts/Executor.md`: `supportsResume`, the `--resume`
    argv position, the cache-invalidation note.
  - `docs/concepts/Runner.md`: session capture + resolution, the
    `resume_unavailable` / `resume_unsupported` failure reasons.
  - `docs/concepts/Runs-DB.md`: the `session_id` column.
  - `docs/Open-Questions.md`: append-vs-fork semantics for a resumed
    session across iterations.

- **Compatibility**: additive. Factories that declare no `resume:`
  produce a byte-identical argv and an unchanged `NodeResult` shape
  apart from the new `session_id` field (populated for every dispatch,
  `null` when no init line was seen). `runs.db` gains a nullable
  column; pre-v4 rows read back as `null`.
