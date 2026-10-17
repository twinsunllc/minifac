## 1. Runner

- [x] 1.1 `src/runner/substitute.ts`: `node` and `edge` namespaces; unknown
      fields and sub-paths verbatim; `substituteInputs` leaves them alone
- [x] 1.2 `src/runner/run.ts`: `QueueItem.via` set on traversal; node/edge
      scope for prompt, base and cwd; park records `via`; resume seed
      rebuilds it from `ResumeState.via`
- [x] 1.3 `src/runner/result.ts`: `ParkedRun.via`, `pending[].via`
- [x] 1.4 `src/runner/resume.ts`: `ResumeState.via`

## 2. Tests

- [x] 2.1 `substitute.test.ts`: render, empty, verbatim, no scope,
      load-time pass-through
- [x] 2.2 `run.iteration-tokens.test.ts`: three-pass loop, start node,
      pause resume, ignored `via`, answer resume, `uses:` binding and cwd,
      unknown field
- [x] 2.3 `run.park.test.ts`: `parked.via` set for an edge-entered
      dispatch, absent for a start node and a resume seed

## 3. Docs

- [x] 3.1 ADR 0050, `docs/concepts/Factory.md`, `docs/concepts/Cycle.md`,
      `docs/CLI.md`, CHANGELOG
- [x] 3.2 Fold the delta into `openspec/specs/graph-runner/spec.md`
