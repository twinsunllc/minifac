## 1. Decision

- [x] 1.1 `docs/decisions/0055-Value-Edges-And-Node-Routing.md`

## 2. Schema and load-time checks

- [x] 2.1 `src/factory/value-edges.ts`: `ValueConditionSchema`,
      `edgeWhenKey`, `resolveOutputPath`, `conditionMatches`,
      `validateValueEdges`
- [x] 2.2 `src/factory/schema.ts`: `when` union, `EdgeWhen` type
- [x] 2.3 `src/factory/loader.ts`: `validateValueEdges` in
      `validatePostSchema`
- [x] 2.4 `src/factory/cycles.ts`: `uncovered_cycle` warning carries the
      key form of `when`
- [x] 2.5 `src/index.ts`: export the helpers and types

## 3. Runtime

- [x] 3.1 `src/runner/run.ts`: value-edge selection, no-match stderr line,
      key via `edgeWhenKey` for counts, resume rehydration and `via`
- [x] 3.2 `src/runner/result.ts`, `src/runner/resume.ts`: key format docs

## 4. Viewer

- [x] 4.1 `src/serve/web/edge-style.js`, `app.js`, `style.css`: on-value
      style, marker and condition tooltip

## 5. Tests

- [x] 5.1 `src/factory/value-edges.test.ts`: schema cases, key, matching,
      load-time path/value/overlap checks, step-declared schema
- [x] 5.2 `src/factory/budget-warnings.test.ts`: cycles closed by value
      edges
- [x] 5.3 `src/runner/run.value-edges.test.ts`: three-way route, no-match
      fallback, missing and mismatched values, outcomes, fan-out, budgets,
      park/resume
- [x] 5.4 `src/serve/web-edge-style.test.ts`: on-value style and tooltip
      text

## 6. Docs

- [x] 6.1 `docs/concepts/Factory.md`, `Runner.md`, `Cycle.md`,
      `Outputs.md`, `docs/Open-Questions.md`
- [x] 6.2 `CHANGELOG.md` `[Unreleased]`
