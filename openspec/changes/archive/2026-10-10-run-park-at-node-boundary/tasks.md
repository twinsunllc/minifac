## 1. Runner

- [x] 1.1 `src/runner/run.ts`: `RunOptions.onNodeBoundary`,
      `nodeBoundaryTimeoutMs`, `DEFAULT_NODE_BOUNDARY_TIMEOUT_MS`; consult
      the hook after admission and before `recordNodeStart`, only with one
      dispatch pending; park; fail open with a `stderr` event
- [x] 1.2 `src/runner/result.ts`: `RunStatus` / `RunReason` gain `parked`;
      `ParkedRun`; `RunResult.parked`
- [x] 1.3 `src/runner/resume.ts`: `ResumeState.reason`, `resumedAt`,
      `edgeTraversals`
- [x] 1.4 `src/runner/run.ts`: pause-resume seeding (no exemption, no
      block, carried `resumed_at`); edge counters from `edgeTraversals`;
      edge keys `<from>-><to>:<when>`
- [x] 1.5 Storage and consumers accept the `parked` status
- [x] 1.6 `src/index.ts`: export the new types and the constant

## 2. Tests

- [x] 2.1 `run.park.test.ts`: park between nodes and before the first
      node; no hook and a continue hook are identical; fail open on
      throw, reject and timeout; no call after a terminal node or an
      unrecovered failure; no park at a fan-out boundary
- [x] 2.2 `run.park.test.ts`: park → `resumeStateFromStore` → pause resume
      runs the remaining nodes once each (real SQLite store)
- [x] 2.3 `run.park.test.ts`: a `max_traversals` revise loop parked and
      resumed takes the uninterrupted run's path; a control without the
      counts does not; junk counts are ignored
- [x] 2.4 `run.park.test.ts`: pause-resume privileges; queue-head budget
      skip is not consulted; abort semantics unchanged
- [x] 2.5 `run.resume.test.ts`: an answer resume given `edgeTraversals`
      starts from them

## 3. Docs

- [x] 3.1 ADR 0048; "amended by 0048" notes on ADR 0042 and 0043
- [x] 3.2 CHANGELOG `[0.1.3]`, version 0.1.3
- [x] 3.3 Fold the deltas into `openspec/specs/graph-runner/spec.md`
