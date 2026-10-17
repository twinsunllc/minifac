---
status: accepted
date: 2026-10-17
supersedes: []
superseded-by: null
tags: [decision]
---

# 0053: Loop budgets per elementary cycle, shipped warn-first

## Context

`findUncoveredCycles` (`src/factory/cycles.ts`) checks loop budgets per
strongly connected component: a component passes when any of its nodes
has `max_iterations` or any edge inside it has `max_traversals`. An
uncapped inner loop therefore loads clean whenever another loop in the
same component is capped, and it can spin without bound at run time.
scarif-factory FINDINGS F9 is that shape:

```yaml
edges:
  - { from: plan, to: implement }
  - { from: implement, to: review }
  - { from: review, to: implement, when: on_failure }                    # no budget
  - { from: review, to: verify }
  - { from: verify, to: implement, when: on_failure, max_traversals: 3 }
  - { from: verify, to: done }
```

`review → implement` can be taken forever; the budget on
`verify → implement` never comes into play. (twinsunllc/minifac#41;
SCARIFW-2248.)

minifac is public, so a graph that loads today must not start failing in
a minor release.

## Decision

### The rule

**Every elementary cycle needs a budget on it**: at least one edge of the
cycle has `max_traversals`, or at least one node of the cycle has
`max_iterations`. The edge's `when` makes no difference: an `on_success`,
`on_failure` or `on_error` edge's `max_traversals` covers the cycles it
lies on, and every cycle needs one whatever kind of edges close it
([[0052-On-Error-Edges]]). Parallel edges between the same two nodes with
different `when` are different edges: capping the `on_failure` one leaves
a cycle through an uncapped `on_success` twin uncovered.

**A node's `max_iterations` covers every cycle through that node.** The
[[Runner]] refuses to dispatch a node past its `max_iterations` (an edge
into an exhausted node is skipped as budget-exhausted), so no cycle that
passes through the node can be taken more often than that. One
`max_iterations` on a node every loop shares, such as `implement` in F9,
therefore silences all of those loops at once. That is intended: it
bounds them all.

### How it is checked

Every elementary cycle is covered exactly when the **residual graph** is
acyclic: the graph without the budgeted edges and without the
`max_iterations` nodes (and the edges touching them). A cycle in the
residual graph uses no budgeted edge and no budgeted node; a cycle not in
it contains one. So the check needs no enumeration of elementary cycles,
which can be exponential in the number of nodes.

`findUnbudgetedCycles` runs a depth-first search over the residual graph,
from the start nodes first and then every other node, in declaration
order, following edges in declaration order. The first back-edge it meets
closes a cycle. That cycle (its nodes in order, from the node the edge
enters) and **that back-edge, as the edge to cap**, are reported. The
edge is removed from the residual graph and the search runs again, until
the residual graph is acyclic. The list is therefore complete: adding
`max_traversals` to every edge it names leaves no uncovered cycle. In F9
the search goes `plan → implement → review` and meets `review →
implement`, the loop's return edge, which is the edge an author caps.

### Why per elementary cycle, not per back-edge

The ticket allowed either. "Every back-edge needs a budget" depends on
the search: which edges are back-edges changes with the DFS root and the
order nodes and edges are declared in. Reordering nodes, or renaming one,
could change whether a graph loads. "Every elementary cycle needs a
budget" is a property of the graph alone, and it is what the
`factory-schema` spec already says ("every cycle SHALL be covered"). The
DFS is used only to choose which edge to *suggest*; that choice can
depend on declaration order, the verdict cannot.

### Warn first, error at the next major

- A component with **no budget anywhere** stays a load error, with the
  existing message. Nothing that fails to load today starts loading.
- An uncovered elementary cycle inside a component that does carry a
  budget **loads with a warning**. `loadFactory` returns it in
  `LoadedFactory.warnings` as a `FactoryLoadWarning`:
  `{ code: "uncovered_cycle", sourcePath, nodes, edge: { from, to, when },
  message }`. `minifac run` (and `run --resume`) writes each to stderr as
  `warning: <sourcePath>: <message>` and runs; `minifac autorun` logs it as
  a `load-warning` event when it starts a run of that factory.
- `loadFactory(path, cwd, { strictBudgets: true })` and the
  `--strict-budgets` flag on `minifac run` and `minifac autorun` turn the
  warnings into a `FactoryLoadError` that names every uncovered cycle and
  its edge to cap.
- **At the next major version** strict becomes the default: an uncovered
  cycle is a load error. That release's notes carry the migration: run
  the factory under `--strict-budgets` (or `strictBudgets: true`) on the
  current minor, and add `max_traversals` to each edge the warnings name
  (or `max_iterations` to a node on the cycle).

`minifac serve` loads factories in the default mode and ignores the
warnings; its behaviour is unchanged.

## Rejected alternatives

- **Per back-edge.** Declaration-order dependent, see above.
- **Enumerate elementary cycles (Johnson's algorithm) and check each.**
  Exponential in the worst case, and the residual-graph check gives the
  same verdict in polynomial time.
- **Error by default now.** Breaks graphs that load today in a minor
  release, which the project's public status rules out.
- **Name the `extends:` parent file that declared the uncapped edge.**
  The warning names the loaded file (`sourcePath`). Pointing at the
  parent would need each edge's provenance out of `resolveExtendsChain`;
  not done here.

## Consequences

- An uncapped inner loop in a capped component is visible on every load
  and can be refused today with `--strict-budgets`.
- Factories outside this repository (scarif-factory, the scarif-workflows
  library, client factories) may warn after a bump. Loading each of them
  under `--strict-budgets` before the next major lists what to cap.
- `LoadedFactory.warnings` is optional in the type, so a `LoadedFactory`
  built by hand still type-checks; `loadFactory` always sets it (`[]` when
  clean).

## Related

- [[Cycle]]
- [[0002-Cycles-First-Class]]
- [[0052-On-Error-Edges]]
- `openspec/changes/loop-budgets-per-cycle/`
