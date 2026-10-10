## Why

Pausing a running Scarif factory job today does not stop its graph: the
whole minifac run lives inside one claimed stage, and `pause-semantics`
forbids killing a running stage. The captain ruled (SCARIFW-2222) that a
pause should let the node in flight finish, park the run before its next
node, and resume it there on unpause. The contract is scarif-spec's
`factory-pause-at-node-boundary` (scarif-spec#365, design D1–D4, tasks
2.1–2.3). minifac has no point between nodes where a caller can stop a
run, and its resume entry point (ADR 0042) can only resume as an
answered ask: it exempts the seed from `max_iterations`, appends the
human-answer block, renders `run.resumed_at` as the seed, and starts
every edge budget at zero.

## What Changes

- **ADDED** `graph-runner` "Between-node boundary hook and park":
  `RunOptions.onNodeBoundary({ nodeId, iteration, first })` is consulted
  once a dispatch is admitted and before it starts, only while exactly one
  dispatch is pending. `"park"` ends the run with `status: "parked"`,
  `reason: "parked"` and a `parked` payload (`nodeId`, `iteration`,
  `pending`, `edgeTraversals`). A hook that throws, rejects or outlives
  `nodeBoundaryTimeoutMs` (default 10 s) counts as continue and is
  reported as a `stderr` event.
- **MODIFIED** "Resumed runs": `ResumeState` gains `reason`
  (`"answer"` | `"pause"`), `resumedAt` and `edgeTraversals`. Supplied
  edge counts seed the traversal counters. A pause resume's seed is
  checked against `max_iterations` like any dispatch.
- **MODIFIED** "Resume feedback delivery" and "Resume-seed, follow-up and
  prior-asks run-scope tokens": a pause resume appends no human-answer
  block, and renders `run.resumed_at` from `resumedAt`.
- **MODIFIED** "Run termination" and "Run result is structured": the
  `parked` status.
- Edge-traversal keys become `<from>-><to>:<when>`. They were internal
  until now; the park payload makes them part of the contract.

## Impact

- Affected specs: `graph-runner`
- Affected code: `src/runner/run.ts`, `src/runner/result.ts`,
  `src/runner/resume.ts`, `src/storage/run-store.ts`, `src/index.ts`; the
  widened `RunStatus` is passed through in `src/serve/run-registry.ts`,
  `src/brief/activity.ts`, `src/cli/briefs.ts`, `src/outputs/prune.ts`
  and `src/cli.ts`.
- No breaking change for a caller that supplies no hook and no new resume
  field: the run is identical. `RunStatus` gains a member, so a caller
  that switches exhaustively on it needs a `parked` case.
- ADR 0048; amends ADR 0042 §1–2 and ADR 0043 for pause resumes.
