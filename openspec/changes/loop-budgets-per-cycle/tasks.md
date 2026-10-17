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

## 5. Docs

- [x] 5.1 ADR 0053, `docs/concepts/Cycle.md`, `docs/CLI.md`, CHANGELOG
- [ ] 5.2 Fold the delta into `openspec/specs/` (`/opsx:archive`)
