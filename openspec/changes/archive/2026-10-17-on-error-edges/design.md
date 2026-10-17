## Context

The runner routes on `status` alone. Executors already know whether
they produced a judgment (a sentinel, an exit code inside `expect.exit`,
a merge-tree verdict) or could not (spawn failure, timeout, signal,
API error), but report both as `failed`.

## Decisions

1. **An additional field, not a third status.** The terminal `status`
   event gains an optional `outcome`; `status` stays
   `succeeded | failed`, so no consumer that matches it changes.
   Absent means the status's own outcome, so a third-party executor
   keeps its old meaning.
2. **Declared, not traversable, decides the fallback.** An error takes
   `on_error` edges when the node declares any, else `on_failure`. An
   exhausted `on_error` budget ends the run `budget_exhausted` instead
   of re-entering the revise loop the change exists to protect.
3. **The runner fills in `outcome`** on every terminal status event it
   delivers and persists, so stream consumers never derive it.
4. **The runner's own failures are errors**: pre-spawn resume failure,
   a stream with no terminal status, and `missing_required_output`
   after nudges (the node claimed success without its outputs). The
   `RunResult.log` entry is updated by that override too.
5. **No new `RunReason`.** An errored node with no edge ends
   `node_failed`; the outcome is in the log and the records.
6. **Optional in the types.** `NodeResult.outcome`,
   `RecordNodeEndInput.outcome` and `NodeExecutionRow.outcome` are
   optional because scarif-worker builds them structurally; the runner
   sets them on every dispatch.
7. **Exceptions thrown out of `run()` are not caught.** They stay
   defects that propagate out of `runFactory`.

## Alternatives rejected

- `status: "errored"` (breaks consumers), `RunReason: node_errored`
  (changes a matched value), fall-through to `on_failure` on an
  exhausted `on_error` budget (see 2), and treating a claude exit 0 with
  no sentinel as an error (changes success routing). See ADR 0052.
