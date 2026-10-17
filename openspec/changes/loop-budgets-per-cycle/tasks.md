## 1. Analysis

- [x] 1.1 `src/factory/cycles.ts`: `findUnbudgetedCycles` — residual graph
      without budgeted edges and `max_iterations` nodes; DFS from start
      nodes in declaration order; report each back-edge with its cycle,
      remove it, repeat; skip components `findUncoveredCycles` reports

## 2. Loader and API

- [x] 2.1 `src/factory/loader.ts`: `strictBudgets` option,
      `FactoryLoadWarning`, `LoadedFactory.warnings`,
      `formatFactoryLoadWarning`; strict throws `FactoryLoadError`
- [x] 2.2 `src/index.ts`: export `FactoryLoadWarning` and
      `formatFactoryLoadWarning`

## 3. CLI

- [x] 3.1 `minifac run` and `run --resume`: `--strict-budgets`; otherwise a
      `warning:` line per warning on stderr
- [x] 3.2 `minifac autorun`: `--strict-budgets`; otherwise a
      `load-warning` event per warning

## 4. Tests

- [x] 4.1 `cycles.test.ts`: F9, fully capped, `max_iterations`, self-loop,
      two loops, overlapping loops, `on_error` budget, parallel edges,
      no-budget component left to the hard error, determinism
- [x] 4.2 `budget-warnings.test.ts`: loader F9 warn and strict, capped
      graphs silent in both modes, hard error kept, `examples/` strict
- [x] 4.3 `cli.test.ts`, `cli.resume.test.ts`, `run-brief.test.ts`,
      `autorun-integration.test.ts`: warn and strict through each command

## 5. Warning surfaces (SCARIFW-2255)

- [x] 5.1 `autorun-tui` delta: autorun forwards `load-warning` to the TUI
      renderer; the reducer keeps it (`loadWarnings`); the brief-list pane
      draws it
- [x] 5.2 `serve-daemon` delta: `RunRegistry.start` opens the run's events
      with a `__runner__` `warning:` line per load warning;
      `POST /api/runs` returns `warnings`
- [x] 5.3 Tests: `autorun-reducer.test.ts`, `brief-list-pane.test.tsx`,
      `autorun-integration.test.ts` (TUI mode), `run-registry.test.ts`,
      `server.test.ts`; `cli.test.ts` covers `autorun --strict-budgets`

## 6. Docs

- [x] 6.1 ADR 0053, `docs/concepts/Cycle.md`, `docs/CLI.md`, CHANGELOG
- [ ] 6.2 Fold the deltas into `openspec/specs/` (`/opsx:archive`)
