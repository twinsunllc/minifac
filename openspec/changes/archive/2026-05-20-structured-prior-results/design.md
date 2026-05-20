## Context

Today the runner accumulates a `RunHistoryEntry[]` of every event
yielded by every executor — `stdout`, `stderr`, `status` — and
snapshots it into each scheduled node's `RunContext.history`. The
claude executor JSON-serializes that snapshot into the user-message
content of its stream-json stdin frame, followed by `\n\n---\n\n`
and then the prompt.

This worked while runs were small. It broke in the
`run-history-persistence` dogfood when apply emitted ~$34 of
stream-json events; verify's preamble then exceeded the 1M-token
context window and the CLI returned `"Prompt is too long"`. The
on-failure retry also re-emitted apply's history, so the cycle
couldn't recover automatically.

Decision `0014-Structured-Prior-Results.md` is binding: replace
the run-wide event pass-through with a structured prior-results
array. The raw event log still lands in [[Runs-DB]] — that's
unchanged. Only the per-node prompt preamble shape changes.

## Goals / Non-Goals

**Goals:**

- Per-node prompts stay bounded regardless of run size.
- The verify → apply on_failure cycle still iterates correctly:
  apply iter 2 sees verify iter 1's REASON.
- The Runs-DB event log is unaffected. Raw events still persist
  there for debugging, the viewer, and future tools.
- One entry appended to `priorResults` per node execution
  (succeeded or failed), in completion order.
- The wire format change is locked in by a snapshot test so a
  future regression cannot silently reintroduce the bug.

**Non-Goals:**

- An opt-in or declarative way for a node to receive raw events
  (e.g. `receive_history`, `with: { history: [...] }`, per-node
  filters). Premature — no current node needs it. Future
  consumers query Runs-DB. Rejected in
  [[0014-Structured-Prior-Results]] alternatives.
- A change to the sentinel format or regex. The REASON line is
  exactly the existing format; this change just elevates it to
  load-bearing.
- A summarization or trimming layer over the existing event
  history. That solves the wrong problem — the design
  conflated "transcript for debugging" with "context for the
  next node."
- A new public API surface. The `RunContext.priorResults` field
  replaces `history` in the same `RunContext`; no separate
  callback or store hook.
- Changes to event streaming (`onEvent`). Consumers still see
  every event in real time — only the per-node *prompt
  preamble* shape changes.

## Decisions

### `NodeResult` shape

```ts
export interface NodeResult {
  nodeId: string;
  iteration: number;
  status: "succeeded" | "failed";
  reason: string | null; // sentinel REASON when failed; null otherwise
  startedAt: number;     // ms since run start
  endedAt: number;       // ms since run start
}
```

- `nodeId` and `iteration` are exactly the values the runner
  already tracks for that execution.
- `status` is the executor's terminal status as derived today
  (sentinel-then-exit-code; see node-executor spec).
- `reason` is captured from the terminal `status` event's
  `meta.sentinel` field when the executor reports
  `meta.reason === "sentinel_failed"`. Otherwise `null` —
  including for successful executions and for non-sentinel
  failures (exit-code-derived). This keeps the field a one-line
  human string when present and unambiguous when absent.
- `startedAt` / `endedAt` are run-relative ms (matching the
  existing `RunHistoryEntry.emittedAt` convention).

The schema is closed: extra fields would tempt callers to add
ad-hoc passthrough, which is the exact failure this change
removes. If more fields are needed later, they get added through
OpenSpec.

### Replace `RunHistoryEntry` with `NodeResult`

The simpler path is to rename in place rather than keep an alias.
Aliases-for-one-release patterns add maintenance for no real
external consumer — `RunHistoryEntry` is only referenced by the
runner, executor, and tests inside this repo. Pick the cleaner
path: delete `RunHistoryEntry` and `RunContext.history`; introduce
`NodeResult` and `RunContext.priorResults`.

Runner internals keep an in-memory `priorResults: NodeResult[]`
in place of the prior `history: RunHistoryEntry[]`. The
`onEvent` consumer callback still receives every event in real
time — its shape is unchanged. The `RunHistoryEntry` shape is
no longer needed at all and is deleted with the rename.

### Append exactly one entry per node execution

Each entry is appended at node-end, after the terminal status
has been determined. Concretely, the runner appends inside the
same block that pushes to `log` and calls `store.recordNodeEnd`
— right after the executor's event loop drains and `finalStatus`
is resolved.

This is exactly one entry per execution; not per-iteration in
some abstract sense, but per actual run of the node. Skipped
nodes (max_iterations budget hit at pop time) do not get an
entry — they did not execute. This matches the existing
`log: ExecutionLogEntry[]` semantics.

### Snapshot timing

Each scheduled node's `RunContext.priorResults` is a frozen
snapshot taken immediately before dispatch — the same point
`history` was snapshotted today. v0 is single-flight so the
snapshot doesn't grow during a node run; the rule is documented
to bind future fan-out, just like the existing history snapshot
scenario.

### Wire format

The claude executor's stdin user-message content becomes:

```
<priorResults JSON>\n\n---\n\n<effective prompt>
```

where `<priorResults JSON>` is `JSON.stringify(ctx.priorResults)`.
For a brand-new run the array is empty, so the preamble is
`[]\n\n---\n\n<prompt>` (today's history-empty case is similarly
`[]\n\n---\n\n<prompt>`, so the worst-case-empty wire format is
unchanged in shape).

The wire-format comment block at the top of `src/executor/claude.ts`
SHALL describe the new shape. The wire-format snapshot test is
updated to lock the new preamble.

### Cycle feedback via REASON

For the verify → apply on_failure cycle:

1. verify iter 1 fails. Its sentinel REASON line populates
   `NodeResult.reason` on the entry appended to `priorResults`.
2. apply iter 2 is scheduled. Its `RunContext.priorResults`
   contains apply iter 1's entry (status: `succeeded`,
   `reason: null`) and verify iter 1's entry (status: `failed`,
   `reason: "<one-line-reason>"`).
3. The claude executor serializes that two-element array into
   apply iter 2's stream-json preamble. The model sees verify's
   REASON and addresses it.

The REASON line was already required on failure by
[[0007-Sentinel-Runner-Injects]]; this change elevates it from
"strongly encouraged for clarity" to "load-bearing for cycle
iteration." Factory prompts that emit `MINIFAC_STATUS: failed`
without a meaningful REASON degrade the cycle.

### Reason capture site

The runner derives `reason` from the terminal status event's
`meta` field as the executor reports it. Specifically:

- If `meta.reason === "sentinel_failed"` and
  `typeof meta.sentinel === "string"`, the entry's `reason` is
  `meta.sentinel` trimmed of trailing whitespace.
- Otherwise `reason` is `null`. (Successes do not carry a
  reason. Non-sentinel failures — e.g. exit code 1 with no
  sentinel — also yield `null`; the cycle contract requires the
  factory to emit a sentinel REASON to get useful feedback.)

This keeps reason capture in the runner, where it sits next to
the `priorResults` append site, rather than threading another
field through the executor's typed shape.

## Risks / Trade-offs

- **Bridge from non-sentinel failures.** An executor that fails
  via exit code without emitting a sentinel REASON produces an
  entry with `reason: null`. The cycle still iterates (apply
  iter 2 still runs) but apply doesn't know *why*. Mitigation:
  the factory prompt should require the sentinel. The auto-
  injected sentinel block (per
  [[0007-Sentinel-Runner-Injects]]) means every claude-executor
  node ships with that requirement by default.
- **Backwards compatibility.** This is a breaking change to the
  `RunContext` shape. Acceptable because `RunContext` is
  internal to this repo — no external executor implementations
  exist yet (v0 is claude-only). When a second runner lands
  (codex, opencode), it accepts the new shape.
- **No raw-event escape hatch.** Some future node *might* want
  the raw transcript. That node is hypothetical today. The
  alternatives section of [[0014-Structured-Prior-Results]]
  rejected speculative knobs; Runs-DB is the path when a real
  consumer appears.
- **Reason capture in the runner.** Pulling `reason` from the
  executor's `meta.sentinel` is a small protocol assumption. The
  claude executor already emits it that way (locked by tests in
  the sentinel scenarios); a future executor must populate the
  same `meta` field if it wants its REASON to surface. This is
  documented in `node-executor`'s sentinel requirement and in
  the wire-format comment block.
