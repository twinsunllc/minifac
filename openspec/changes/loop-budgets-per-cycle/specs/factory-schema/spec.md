## MODIFIED Requirements

### Requirement: Cycle budgets are mandatory

If the graph contains any cycle, every elementary cycle SHALL be covered
by at least one budget — either a `max_traversals` on an edge in the
cycle (of any `when`), or a `max_iterations` on a node in the cycle. A
node's `max_iterations` covers every cycle through that node. Parallel
edges between the same nodes are distinct edges: a budget on one does not
cover a cycle through another.

The loader SHALL refuse a factory containing a cyclic strongly connected
component with no budget on any of its nodes or internal edges.

Until the next major version, a factory whose every cyclic component
carries a budget but which contains an uncovered elementary cycle SHALL
load, and the loader SHALL return a warning for each uncovered cycle
with code `uncovered_cycle`, the absolute path of the loaded file, the
cycle's nodes in order, and an edge of the cycle whose `max_traversals`
would cover it (`from`, `to`, `when`). Adding `max_traversals` to every
reported edge SHALL leave no uncovered cycle. Under strict budgets (the
`strictBudgets` loader option, or `--strict-budgets` on `minifac run` and
`minifac autorun`) the loader SHALL refuse such a factory with an error
naming each uncovered cycle and its edge. At the next major version
strict budgets become the default (ADR 0053).

#### Scenario: Unbounded cycle is rejected

- **WHEN** the loader reads a factory whose graph contains nodes A → B → A
  with no `max_traversals` on either edge and no `max_iterations` on
  either node
- **THEN** validation fails with an error identifying the cycle and the
  missing budget

#### Scenario: Cycle covered by an edge budget is accepted

- **WHEN** the loader reads a factory whose graph contains nodes A → B → A
  where the B → A edge has `max_traversals: 3`
- **THEN** validation succeeds

#### Scenario: An uncapped inner loop in a capped component warns

- **WHEN** the loader reads plan → implement → review → verify → done
  with `review → implement` (`on_failure`, no budget) and
  `verify → implement` (`on_failure`, `max_traversals: 3`)
- **THEN** the factory loads with one `uncovered_cycle` warning whose
  nodes are `implement`, `review` and whose edge is
  `review → implement` (`on_failure`)

#### Scenario: Strict budgets refuse the uncapped inner loop

- **WHEN** the same factory is loaded with strict budgets
- **THEN** validation fails with an error naming the cycle
  implement → review → implement and the edge review → implement

#### Scenario: A fully capped nested graph is silent in both modes

- **WHEN** the same factory also declares `max_traversals: 2` on
  `review → implement`
- **THEN** it loads with no warning, with and without strict budgets

#### Scenario: `max_iterations` covers every cycle through its node

- **WHEN** the uncapped factory instead declares `max_iterations: 4` on
  `implement`
- **THEN** it loads with no warning, with and without strict budgets
