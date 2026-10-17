## Why

Loop budgets are checked per strongly connected component, so an
uncapped inner loop loads clean whenever another loop in the same
component carries a budget, and it can spin without bound
(scarif-factory FINDINGS F9; twinsunllc/minifac#41; SCARIFW-2248). The
spec already says every cycle SHALL be covered; the loader checks less.

## What Changes

- **MODIFIED** `factory-schema` "Cycle budgets are mandatory": coverage is
  per elementary cycle (a `max_traversals` edge or a `max_iterations` node
  on it; a node's `max_iterations` covers every cycle through it). A
  component with no budget anywhere is still refused. An uncovered cycle
  inside a component that carries a budget elsewhere loads with a
  structured warning by default and is refused under strict budgets
  (`strictBudgets` loader option, `--strict-budgets` on `minifac run` and
  `minifac autorun`). Strict becomes the default at the next major
  version.
- **ADDED** `autorun-tui` "Autorun TUI shows factory load warnings" and
  `serve-daemon` "Runs carry the factory's load warnings" (SCARIFW-2255):
  the warning reaches the user in autorun's TUI mode and in runs started
  through `minifac serve` (the `201` body's `warnings` and the run's
  events).

## Impact

- `src/factory/cycles.ts` (`findUnbudgetedCycles`), `src/factory/loader.ts`
  (`strictBudgets`, `FactoryLoadWarning`, `LoadedFactory.warnings`,
  `formatFactoryLoadWarning`), `src/index.ts`, `src/cli.ts`,
  `src/cli/{run-brief,resume-run,autorun}.ts`, `src/tui/autorun-reducer.ts`,
  `src/tui/brief-list-pane.tsx`, `src/serve/{run-registry,server}.ts`.
- Additive in this minor: no graph that loads today is refused unless
  strict is opted into. Graphs elsewhere may start warning.
- Decision record: `docs/decisions/0053-Loop-Budgets-Per-Cycle.md`.
