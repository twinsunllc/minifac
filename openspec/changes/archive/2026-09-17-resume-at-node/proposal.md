## Why

A factory run that needs a human ends as a failed run. In minifac,
"emit an ask and halt" is a node that fails with no `on_failure` edge
(scarif-factory FINDINGS F7): the run ends naming the node and the
node's `REASON` line is the ask. There is no way back in. On
2026-09-17 two correct escalations became manual work — one where a
PR was verified correct but an acceptance criterion could not be
proved before deploy, and one where the answer to a spec
contradiction took a human one sentence — and in both cases the only
options were re-running the graph from its start nodes (a second PR,
the whole cost again) or finishing by hand.

What is missing is a resume: dispatch ONE named node, with the parked
run's results already in scope and the human's answer bound as
feedback, on the same worktree and branch. ADR 0040 made an
escalation node expressible (a node reachable only by `on_failure`
no longer auto-starts) and ADR 0041 kept a failed node's outputs
addressable, so the state a resume needs is already there. Only the
entry point is missing.

## What Changes

- **ADDED** `graph-runner` "Resumed runs": `RunOptions.resume =
  { at, priorResults, iterations, feedback }` seeds the queue with
  the named node alone instead of the declared start nodes,
  rehydrates `priorResults` and the per-node iteration counters,
  exempts the seeded dispatch from that node's `max_iterations`,
  spends no `max_traversals` slot, and continues the same run row
  through the new optional `RunStore.reopenRun`.
- **ADDED** `graph-runner` "Resume feedback delivery": the answer is
  delivered twice — as `{{ run.feedback }}` for the whole run, and as
  a delimited runner-injected human-answer block appended to the
  seeded dispatch's prompt only. Two channels because the step
  library that would bind the token lives in another repository
  (twinsunllc/scarif-workflows) and is out of scope here, so the
  runner cannot rely on the token reaching the model.
- **ADDED** `graph-runner` "`{{ run.feedback }}` token": resolves the
  run's feedback, or the empty string when the run has none.
- **ADDED** `run-storage` "Resume-state reconstruction": two new
  OPTIONAL `RunStore` methods, `getNodeExecutions` and `reopenRun`,
  plus a `kind` filter on `getRunEvents`; and
  `resumeStateFromStore`, which rebuilds a finished run's
  `ResumeState` from those rows.
- **ADDED** `run-cli` "`minifac run --resume`": `minifac run --resume
  <run> --at <node> [--feedback <file>]` resumes a recorded run in
  its own worktree and branch, appending to the same `runs` row. Six
  named refusals.
- **MODIFIED** `run-cli` "`minifac run` command": the positional
  argument becomes optional, because `--resume` takes a run instead.
  The two forms are mutually exclusive.

## Impact

- Affected specs: `graph-runner`, `run-storage`, `run-cli`
- Affected code: `src/runner/run.ts`, `src/runner/resume.ts` (new),
  `src/runner/substitute.ts`, `src/runner/result.ts`, `src/index.ts`,
  `src/storage/run-store.ts`, `src/storage/sqlite.ts`, `src/cli.ts`,
  `src/cli/resume-run.ts` (new)
- No breaking change to an existing run: `RunOptions.resume` absent
  is byte-for-byte today's behaviour, and both new store methods are
  optional so the droid's structurally-typed adapter in
  twinsunllc/scarif-worker keeps compiling.
