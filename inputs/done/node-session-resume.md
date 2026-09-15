---
change: node-session-resume
factory: sdd
base_branch: main
---

## Background

Every node dispatch is a fresh conversation. A node that explores a
repo, reads twenty files, and forms a plan can only hand its successor
a lossy artifact — a plan file, a `value` output, a sentinel REASON
string. Everything the model learned but didn't write down is thrown
away at the process boundary.

The Claude CLI can continue an existing conversation on a different
model (`claude -p --resume <session-id> --model <other>`). That
enables a **cascade**: an explore/plan node on a large model, then
continuation nodes on a cheap model that already know what the first
node found.

minifac can't express it, and couldn't have — it never captures a
session id at all. Nothing in `src/` parses the CLI's `system` / `init`
line and `runs.db` has no column for it; the ids scroll past in raw
stream-json stdout and are lost when the run ends.

The binding decision is at
`docs/decisions/0035-Cross-Node-Session-Resume.md`. Read it first.
Key calls locked:

- **Node-level `resume: <node-id>`**, not a `with:` key and not a step
  input — it names a sibling node, and a reusable step must not need
  to know one.
- **No new model field.** `with.model` already exists; `resume:`
  supplies the other half of the cascade.
- **The runner captures the session id**, not the executor, and
  resolves `resume:` from the latest prior-results entry for the named
  node.
- **Iteration N resumes the NAMED node's latest dispatch**, never the
  resuming node's own prior iteration. Self-resume is rejected at load.
- **An unsatisfiable resume fails before spawn.** No silent
  fresh-session fallback.

## What to do

### 1. Live CLI checks — do these FIRST, before any code

Record the outcomes in the change's `tasks.md`. If either of the first
two fails, stop and re-scope rather than building around a guess.

1. `--resume <id>` accepts the prompt on **stdin** under
   `--input-format stream-json`.
2. Mid-session stdin writes still work under `--resume` (write a
   second stream-json user-message frame after the first `result`
   event and confirm a new turn). This is the nudge loop's
   precondition — if it fails, resume-declaring nodes must set
   `output_nudge_budget: 0` and the spec narrows.
3. The resumed invocation announces a `session_id`, and it equals the
   resumed id.
4. `--resume` + `--model` is accepted and the session transcript's
   per-message `model` fields separate the turns (the cost-attribution
   premise).
5. `--resume` + `--mcp-config`: does the resumed session use the new
   config, restore the original's servers, or both? Becomes a docs
   note either way.
6. Whether the CLI offers a fork-instead-of-append option. Not
   blocking; feeds the Open-Questions entry.

### 2. Factory schema + loader

Add `resume: z.string().min(1).optional()` to `NodeSchema` in
`src/factory/schema.ts` (the object stays `.strict()`), and preserve
it through step inlining in `src/step/inline.ts` alongside the
existing `outputs` / `output_nudge_budget` handling.

Add a post-schema validation pass over the **resolved** factory —
after `extends:` merge and step inlining, alongside the existing
terminal-node / cycle-budget / edge-endpoint checks:

- unknown target id → error naming the declaring node, the value, and
  the source location;
- `resume` equal to the declaring node's own id → error;
- target `cwd` string ≠ declaring node's `cwd` string → error naming
  both node ids and both values. Both omitting `cwd` counts as
  identical. Sessions are scoped per project directory, so a
  mismatched pair could never resolve at run time.

Do **not** add a reachability check — cycles are first-class, so
"the target runs first" isn't statically decidable. Add a test
asserting a later-running target loads without error.

### 3. Executor interface + claude executor

```typescript
// src/executor/types.ts
interface RunContext  { resumeSessionId?: string; }
interface NodeExecutor { readonly supportsResume: boolean; }
interface NodeResult   { session_id: string | null; }
```

`ClaudeExecutor` sets `supportsResume = true`; every other
implementation (including `check-merge` and the test doubles) sets
`false` — strict mode will enumerate them.

Extend `buildCliArgs` to take the resume session id and emit
`--resume <id>` **after** the `--mcp-config` pair and **before**
`--model`, the authority flags, and the `with.args` passthrough.
Thread `ctx.resumeSessionId` at the call site. Update the argv section
of the wire-format comment block at the top of
`src/executor/claude.ts`, including the note that `--resume` +
`--model` is the intended composition and that the swap invalidates
the conversation prompt cache.

### 4. Runner — session capture

In `src/runner/run.ts`, add a session-id scan beside the existing
`parseTurnFromStdout` inspection: a line parsing as JSON with
`type === "system"`, `subtype === "init"`, and a non-empty string
`session_id` updates a per-dispatch box. **Keep the last
announcement** — the CLI emits one init line per turn, so a nudged
dispatch announces several times — and don't assume init is the first
line. Parse failures and off-shape lines are ignored; no event is
altered, suppressed, or reordered.

Push `session_id` onto the `NodeResult` for the dispatch (`null` when
nothing was captured) and pass `sessionId` to
`store.recordNodeEnd(...)`.

### 5. Runner — resume resolution

Before dispatch, when the resolved node declares `resume:`, look up
the latest prior-results entry for the named node (reuse the
`priorMap` the runner already builds) and read its `session_id`.

Fail **before spawning any child process**, yielding a terminal
`failed` status and appending a `NodeResult` with the matching reason:

| `meta.reason` | detail | Condition |
|---|---|---|
| `resume_unavailable` | `no_prior_dispatch` | target hasn't run in this run |
| `resume_unavailable` | `no_session_captured` | target ran, announced no session |
| `resume_unsupported` | — | executor's `supportsResume` is `false` |

No fresh-session fallback in any case. On success set
`ctx.resumeSessionId`; nodes without `resume:` get a context with the
field absent.

Confirm the pre-spawn failure path still does everything a
dispatched-node failure does: `recordNodeStart` / `recordNodeEnd`
bracketing, the log entry, the status event on `onEvent`, and edge
traversal — `on_failure` recovery edges must still fire.

A resume off a **failed** target that produced a session is allowed
and expected: the precondition is a session existing, not the node
having succeeded.

### 6. Storage — schema v4

Add `src/storage/migrations/0004_add_session_id.sql`:

```sql
ALTER TABLE node_executions ADD COLUMN session_id TEXT;
```

Mirror it in the inline `MIGRATIONS` array (`version: 4`,
`name: "add_session_id"`). Add `sessionId?: string | null` to
`RecordNodeEndInput`; bind it in both the UPDATE and the
skipped-node INSERT in `src/storage/sqlite.ts` (`NULL` when omitted).

The column is nullable and **not** unique — two node executions that
continued one conversation legitimately share an id.

### 7. Tests

Next to the code, per repo convention. At least:

- **Loader**: each validation rule; `resume:` alongside `uses:`;
  surviving an `extends:` node override; empty-string / non-string
  rejection; a later-running target loading cleanly.
- **Executor**: `--resume` present with an id and absent without one
  (byte-identical to the pre-change argv); ordering vs `--mcp-config`,
  `--model`, knobs, and passthrough; `supportsResume` is `true`.
- **Runner capture**: capture from the init line; last announcement
  wins; non-JSON / off-shape / non-string `session_id` ignored while
  every line still reaches the event stream unaltered; `null` when no
  init line; capture happens regardless of terminal status.
- **Runner resolution**: threads the target's session; a later
  iteration picks up the target's newer session after the target
  re-runs; a repeated iteration without a target re-run reuses the
  same id; failed-target-with-session still resumes; each of the three
  pre-spawn failure reasons, asserting **no spawn** occurred; an
  `on_failure` edge traverses off a `resume_unavailable` failure.
- **Storage**: fresh DB reaches v4 with the column; a seeded v3 DB
  migrates with prior rows intact and other tables untouched;
  `recordNodeEnd` round-trips an id and a `null`; two rows in one run
  may share an id.

Some existing tests pin values this change moves (the `NodeResult` key
list, `schema_version` = 3 in two places). Update them deliberately.

### 8. Docs

- `docs/concepts/Factory.md` — the `resume:` node field, a worked
  cascade YAML snippet, and the three load-time rules.
- `docs/concepts/Executor.md` — `supportsResume`, the argv position,
  the cache-invalidation note, the MCP finding from § 1.5, and that
  nothing is validated locally.
- `docs/concepts/Runner.md` — capture, the latest-dispatch resolution
  rule, the append-not-snapshot consequence, and the failure table.
- `docs/concepts/Runs-DB.md` — the `session_id` column: nullable,
  non-unique, and what it's for.
- `docs/Open-Questions.md` — append-vs-fork, with the trigger "a
  factory hits context limits inside a resumed revise loop."

### 9. Manual smoke

Run a two-node cascade end-to-end against the real CLI and confirm
(a) the continuation node's session id equals the plan node's,
(b) `node_executions` carries both rows with that id, and (c) the
continuation demonstrably has the plan node's context without an
artifact hand-off. Make the probe honest: have the plan node put
something in its **messages** (e.g. read a file and summarize it) and
have the continuation use a detail from it while forbidden to read
files. A plan node asked to "remember" something it never said does
not transfer it — the cascade carries the transcript, not hidden
reasoning.

## Out of scope

- Resuming a node's own prior iteration (`resume: <self>`), and any
  resume across runs or machines.
- A `resume_policy: strict | fallback` knob. v1 is strict-only.
- Forking a session instead of appending to it.
- Cost-attribution *reporting*. This change persists the join key only.
- Pre-flight existence checks on the CLI's session storage.
- A new shipped example factory — the docs snippet covers authoring,
  and `examples/` is bundled built-in surface.

## Acceptance criteria

- A node declaring `resume: <node-id>` continues that node's
  conversation; paired with `with.model` it runs on a different model
  with the prior node's context intact.
- Nodes without `resume:` produce a byte-identical argv and unchanged
  behavior.
- The three load-time rules reject with errors naming the nodes and
  values involved; reachability is not checked.
- Session ids are captured for every dispatch and land on both
  `NodeResult.session_id` and `node_executions.session_id`.
- Unsatisfiable resumes fail before spawn with `resume_unavailable` /
  `resume_unsupported`, never a silent fresh session, and
  `on_failure` edges still fire.
- `runs.db` migrates to v4 with prior rows intact.
- Full test suite, `npm run check`, and `tsc` all green.
- Concept docs + Open-Questions reflect the new behavior.
