---
status: accepted
date: 2026-10-17
supersedes: []
superseded-by: null
tags: [decision]
---

# 0052: `on_error` edges, and a node error distinct from a judged failure

## Context

An edge takes `when: on_success | on_failure`. A node that crashed, hit a
rate limit or timed out therefore routes exactly like a node that ran and
judged "revise": a runner error sends the run back around a revise loop,
spending its budget on passes that cannot help (scarif-factory FINDINGS
F3 and F10; twinsunllc/minifac#37, first half; SCARIFW-2247). The
[[Executor]] knows which of the two happened; the [[Runner]] throws that
away.

## Decision

### Definitions

- A node **error**: the executor could not produce a judgment. The
  process crashed or exited non-zero without a judgment, timed out, hit
  an API or rate-limit failure, produced an unparseable result, or the
  executor could not start it at all (invalid configuration, missing
  binary, spawn failure).
- A node **failure**: the node ran and reported failure. It is a
  judgment, and the only thing an `on_failure` edge is for.
- Every dispatch has one **outcome**: `success`, `failure` or `error`
  (`NodeOutcome`, exported from the package).

### The executor contract

The terminal `status` event keeps `status: "succeeded" | "failed"` and
gains an optional `outcome`. An executor sets `outcome: "error"` on a
`failed` status when it could not judge. Absent means `success` for
`succeeded` and `failure` for `failed`, so an executor that has never
heard of outcomes keeps its old meaning.

### Mapping for each built-in executor

| Executor | `error` | `failure` |
|---|---|---|
| `claude` | `invalid_with`; `spawn_error`; `missing_binary`; with no `MINIFAC_STATUS` sentinel: a non-zero (or `null`) exit, or a final stream-json `result` event with `is_error: true` (`meta.subtype` carries its subtype, e.g. `error_during_execution`) | `MINIFAC_STATUS: failed`, whatever the exit code |
| `command` | `invalid_with`; a red command with no exit code (`host_missing`, a spawn error, ended by a signal); a red command that `timed_out` or was aborted, even if it exited with a code of its own after SIGTERM; a `result_parse` failure (`result_from` / `result_file`). Any one of these makes the node an error, even under `continue_on_red` with other commands merely red | every red command exited with a code outside its `expect.exit` |
| `check-merge` | `invalid_with`; `missing_base`; `missing_base_ref`; `git_error` | `merge_conflict`; `fast_forward_required` |

The runner's own failure paths:

| Path | Outcome |
|---|---|
| Pre-spawn `resume_unavailable` / `resume_unsupported` | `error` |
| The executor's stream ended with no terminal status | `error` |
| `missing_required_output`: the node claimed success, but declared required outputs are missing after every nudge | `error` |
| Template substitution error | `error` on the runs.db row; the run ends `node_failed` with no edge traversed, as before |
| `unknown_executor` | the run ends before dispatch, as before; there is no node record |

An exception that escapes an executor's `run()` is not caught: it
propagates out of `runFactory` as it did before this change, and is not
routed. The built-in executors catch their own spawn failures and report
them as above.

Two behaviours change for the `claude` executor and the run log:

- A final `result` event with `is_error: true` and no sentinel is now
  `failed` with outcome `error` even when the CLI exited 0. Before, exit 0
  made it `succeeded`. An exit 0 with no sentinel and no `is_error` stays
  `succeeded`.
- `RunResult.log` entries record the `missing_required_output` override:
  `status: "failed"`, `outcome: "error"`. Before, the log entry kept the
  executor's `succeeded` while `priorResults` and runs.db said `failed`.

### Routing

- `success` takes `on_success` edges, as before.
- `failure` takes `on_failure` edges, as before. A judged failure never
  takes an `on_error` edge.
- `error` takes the node's `on_error` edges when the node **declares**
  any, and its `on_failure` edges otherwise. A graph with no `on_error`
  edge therefore routes exactly as before.
- Whether an `on_error` edge is declared decides, not whether one is
  traversable. When every declared `on_error` edge is budget-exhausted,
  the run ends `budget_exhausted`; it does not fall back to `on_failure`.
- An errored node with no edge to take ends the run `node_failed`, as a
  failed one does.

### Budgets

`on_error` edges are ordinary edges for every budget rule:
`max_traversals` counts their traversals under the key
`<from>-><to>:on_error`, so parking, `ParkedRun.edgeTraversals`,
`ResumeState.edgeTraversals` and `ResumeState.via` cover them unchanged.
The loader's cycle check already counts every edge, so a cycle closed
only by `on_error` edges needs a `max_traversals` or `max_iterations`
budget like any other ([[0002-Cycles-First-Class]]). Start-node inference
counts an `on_error` edge as an inbound edge ([[0040-Declared-Start-Nodes]]).

### Records and the stream

- `NodeResult.outcome` (each `priorResults` entry) and
  `ExecutionLogEntry.outcome` (`RunResult.log`).
- runs.db schema v6 adds `node_executions.outcome` (TEXT, nullable),
  written from `RecordNodeEndInput.outcome` and read back as
  `NodeExecutionRow.outcome`. Rows written before v6, and skipped
  nodes, read `null`. A resume rebuilt from the store
  (`resumeStateFromStore`) takes `NodeResult.outcome` from the row, or
  from the row's status when the row has none.
- Every terminal status event the runner delivers to `onEvent` and
  persists carries `outcome`, filled in by the runner when the executor
  left it out. So Scarif can read it from the event stream as well as
  from `recordNodeEnd`.
- No field a consumer reads today changes name or values: `status` stays
  `succeeded | failed`, and `reason`, `meta` and `RunReason` are as they
  were. `NodeResult.outcome`, `RecordNodeEndInput.outcome` and
  `NodeExecutionRow.outcome` are optional in the types so a caller that
  builds them itself (scarif-worker's structurally typed store and
  resume) still type-checks. The runner sets `NodeResult.outcome` on every
  entry, and `RecordNodeEndInput.outcome` on every dispatch it records
  (not on a skipped node's row).

## Rejected alternatives

- **A third status, `status: "errored"`.** Every consumer that matches
  `succeeded | failed` would mis-handle it. An additional field is
  additive.
- **A new `RunReason`, `node_errored`.** Changes a value consumers match
  on; the outcome is already in `log[].outcome` and the records.
- **Fall back to `on_failure` when every `on_error` edge is exhausted.**
  That re-enters the revise loop this change exists to keep errors out
  of. A factory that wants it declares the `on_failure` path from the
  error target instead.
- **Treat a `claude` exit 0 with no sentinel as an error ("unparseable
  result").** It changes success-path routing for every factory whose
  prompts do not ask for the sentinel.
- **Catch exceptions thrown by an executor's `run()` and route them as
  errors.** A thrown exception is a defect in the executor (the
  `check-merge` worktree assertion throws on purpose), and turning it
  into routing would hide it. Not done here.

## Consequences

- A factory can send crashes, rate limits and timeouts to a wait,
  re-poll or escalation node, and keep its revise loop for judgments.
- A third-party executor reports errors by setting `outcome: "error"`;
  until it does, its failures stay failures.
- Scarif reads the outcome once its worker pins a minifac with this
  change; that pin bump is follow-up work.
- A runs.db migrated to v6 is refused by an older minifac build (the
  adapter refuses a schema newer than it knows), so rolling minifac back
  means rolling back to a fresh runs.db or this build. A factory that
  declares `when: on_error` fails to load on an older build, so roll
  factories back first.
