---
status: accepted
date: 2026-05-20
supersedes: []
superseded-by: null
tags: [decision]
---

# 0014: Structured prior-results replace run-wide history pass-through

## Context

The [[Runner]] today (since `core-graph-runner`) accumulates every event
emitted by every node — `stdout`, `stderr`, `status` — into a single
ordered run-wide history. When the runner schedules a node, it JSON-
serializes that entire history into the stream-json input preamble of
the node's prompt. The intent was to let cyclic flows (verify → apply)
see what came before.

The accidental consequence: each downstream node's prompt grows by the
size of all prior work. Apply's stream-json events get re-sent into
verify's prompt, verify's gets re-sent into archive's, etc.

This broke for the first time in the `run-history-persistence` dogfood:
apply's ~$34 of stream-json events pushed verify's prompt past the
1M-token context window. Verify and the on_failure retry both returned
`"Prompt is too long"` and the run had to be finished by hand. The
issue was filed in [[Open-Questions]] as "run-wide history exceeds
context window."

But the deeper issue is that the design was wrong from the start.
Nodes don't actually need each other's *transcripts*:

- **propose** produces a change directory on disk
- **apply** reads `tasks.md` and works through tasks
- **verify** runs commands; cares only whether prior steps succeeded
- **archive** runs the archive command

The cycle case (verify → apply on_failure) is the only one where a
downstream node needs information about an earlier step's outcome —
and what it needs is the *reason for failure*, not the full transcript.
The [[Sentinel]]'s `MINIFAC_STATUS: failed\nREASON: <text>` line
already conveys that.

## Decision

Replace the run-wide event-history pass-through with a structured
`prior_results` array.

- Each completed node execution produces one entry shaped
  `{ nodeId, iteration, status, reason, started_at, ended_at }`.
  `reason` is the sentinel REASON line when present, otherwise null.
- The runner maintains a per-run ordered `priorResults` array. Each
  scheduled node's `RunContext` receives a snapshot of it.
- The [[Executor]] (today: claude) serializes `ctx.priorResults`
  into its stream-json input preamble instead of `ctx.history`.
- The run-wide event log still exists in the [[Runs-DB]] (per
  [[0011-SQLite-for-Runs]]) — it's just not pushed into node prompts.
- Nodes that genuinely need raw prior events in the future (a
  hypothetical `review` or `evaluate` stage, for example) can query
  `runs.db` directly. This capability is **not shipped in this
  change**; it's deferred until a real consumer appears.

## Consequences

- Per-node prompts stay bounded regardless of run size. The
  context-window failure mode goes away.
- Cost drops materially. Today verify and archive each pay to re-read
  apply's full transcript via the stream-json preamble; that's most
  of their token spend. With this change, prompts get only the small
  structured summary.
- The verify → apply on_failure cycle still iterates correctly: apply
  sees that verify failed and what the REASON was. Apply reads the
  actual state on disk for anything more it needs. In practice,
  REASON is enough.
- The sentinel REASON line becomes a load-bearing piece of the cycle
  contract — not optional. Factory prompts that fail without a clear
  one-line REASON degrade the cycle. The [[Sentinel]] decision
  ([[0007-Sentinel-Runner-Injects]]) already requires REASON on
  failure; this decision elevates that from "nice to have" to
  "essential to cycle iteration."
- The [[Runs-DB]] is now the canonical source for raw events. If a
  future node type wants them, querying that DB is the path.

## Alternatives considered

- **Keep the full event history.** Rejected — already broken at the
  context window, and the design conflates "transcript for debugging"
  with "context for the next node," which are different problems.
- **Trim or summarize the history.** Rejected — solves the wrong
  problem. Most of what's currently being sent isn't useful to begin
  with; truncation is just a less-bad version of the same mistake.
- **Opt-in raw access via a `receive_history` knob in `with:`.**
  Rejected as premature. No current node needs it. If a future node
  type emerges (review / evaluate / inspect), it can query
  [[Runs-DB]] directly. Building the opt-in knob speculatively is the
  exact "premature plugin system" anti-goal from
  [[0013-Anti-Goals]].
- **Per-node history filters declared in the factory** (`history:
  ["verify"]` or similar). Same rejection — premature, no consumer.

## Related

- [[Runner]] — implementation home
- [[Executor]] — wire format change
- [[Sentinel]] — REASON line is the cycle-feedback mechanism
- [[Cycle]] — verify → apply re-entry uses structured result, not transcript
- [[Runs-DB]] — raw events still live here for future lookup
- [[0007-Sentinel-Runner-Injects]] — the REASON line that makes this work
- [[0011-SQLite-for-Runs]] — where raw events persist
- [[0013-Anti-Goals]] — why no opt-in knob
- [[Open-Questions]] — removes the history-bloat question
