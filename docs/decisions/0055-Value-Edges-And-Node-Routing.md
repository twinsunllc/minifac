---
status: accepted
date: 2026-10-17
supersedes: []
superseded-by: null
tags: [decision]
---

# 0055: Value-conditioned edges, and node-chosen routing within an allow-list

## Context

An edge branches only on the producing node's outcome. A three-way verdict,
evaluate → implement | verify | escalate, cannot be written: the verdict has
to be flattened to pass/fail and the third route lost
(twinsunllc/minifac#37, second half; scarif-factory FINDINGS F3, F10).
[[0052-On-Error-Edges]] took the first half of #37, giving a node three
outcomes: `success`, `failure` and `error`.

twinsunllc/minifac#54 asks for the stronger form: a judging node names its
next node itself, within a declared allow-list (`routes:` and `next:`;
FINDINGS F4/F7). Both features are routing on a node's result, so they have
to share one model. This record designs both. It implements value edges
(SCARIFW-2251); `routes:`/`next:` is built in SCARIFW-2252 to the design
below.

Two earlier decisions shape the answer. [[0053-Loop-Budgets-Per-Cycle]]
bounds every cycle by a budget on one of its edges or nodes.
[[0054-Step-Output-Schema]] lets a `type: value` output carry a JSON Schema
that the runner validates at node completion. A mismatch is a judged
failure and the value is not indexed.

## Decision

### Value-edge syntax

An edge's `when` takes a third form beside the outcome literals:

```yaml
edges:
  - { from: evaluate, to: verify,    when: { output: result.decision, equals: approve } }
  - { from: evaluate, to: implement, when: { output: result.decision, equals: revise }, max_traversals: 3 }
  - { from: evaluate, to: escalate,  when: { output: result.decision, in: [escalate, blocked] } }
```

- `output` is a path. Its first segment is an output key (the output-key
  grammar, `[a-zA-Z_][a-zA-Z0-9_]*`), and each further `.<name>` segment
  (`[a-zA-Z0-9_-]+`) is a property of a plain object. Arrays are not
  indexed. A path with no property segments tests the whole value.
- Exactly one operator:
  - `equals: <scalar>`, where a scalar is a JSON string, number, boolean or
    `null`;
  - `in: [<scalar>, ...]`, a non-empty list.
- Comparison is strict equality on the parsed JSON, so `1` and `"1"` differ.
  There are no other operators: no negation, ranges, patterns or
  expressions.

The schema rejects a condition with both operators or neither, a non-scalar
`equals`, an empty `in`, a malformed path or an unknown key. An unknown
literal such as `on_weekend` is still rejected, and the error lists the
supported values.

### Which edges a node takes

When a node completes, the runner picks the outbound edges to consider
before it reads any budget:

1. **Outcome `error`.** Value edges are never considered. The node routes
   exactly as ADR 0052 says (`on_error` when one is declared, else
   `on_failure`).
2. **Outcome `success` or `failure`.** If the node declares value edges, the
   runner reads each tested output from the node's indexed outputs (the
   ones the outputs validator accepted) and walks the path.
   - **One or more match.** Every matching value edge is selected, and the
     outcome's literal edges (`on_success`, or `on_failure` for a judged
     failure) are not.
   - **None matches.** This includes an output that is absent, unindexed
     (it failed its schema) or does not parse, and a path that does not
     resolve. The runner writes a stderr line, `value_edges: node "<id>"
     matched no value edge; following <when> edges`, persists it like any
     event, and selects the outcome's literal edges as before. A failed
     node that then traverses nothing ends the run `node_failed`.

A value edge therefore applies on both a success and a judged failure. A
verdict node that fails its own judgment (a `MINIFAC_STATUS: failed` with
`decision: revise`) routes on its value the same way.

A terminal node that succeeds still ends the run before any edge is read.

### Ambiguity

- **Same path, overlapping values: a load error.** Two value edges from one
  node that test the same `output` path and have a value in common (for
  example `equals: revise` and `in: [revise, rework]`) are refused at load.
  The error names both edges and the shared value. This holds even when the
  two edges go to different nodes: the overlap is almost always a typo. A
  value that should start two nodes routes to one node whose `on_success`
  edges fan out.
- **Different paths that both match: fan-out.** Value edges on different
  paths (`result.decision` and `result.risk`) can both match at run time,
  and all of them are traversed. That is the same rule as several
  `on_success` edges from one node today. A load-time check cannot rule this
  out without knowing the values, and refusing it would forbid legitimate
  independent conditions.

There is no declaration-order precedence: the set of edges taken never
depends on the order in which they are written.

### Budgets

A value edge is an ordinary edge for every budget rule:

- `max_traversals` counts its traversals. The traversal key is
  `<from>-><to>:output:<path>=<JSON>` for `equals` and
  `<from>-><to>:output:<path> in <JSON array>` for `in`, for example
  `evaluate->implement:output:result.decision="revise"`. One helper
  (`edgeWhenKey`) builds it for the counter, for `ParkedRun.edgeTraversals`
  and `ResumeState.edgeTraversals` (park/resume carries the count) and for
  `via` (`{{ edge.traversals }}`, ADR 0050). Outcome edges keep
  `<from>-><to>:<when>` unchanged.
- The successor's `max_iterations` applies as for any edge.
- **A matched edge that is exhausted does not fall back.** Selection is made
  before budgets are read, so when the only matching value edge has spent
  its `max_traversals`, the node does not fall through to `on_success` or
  `on_failure`. A failed node ends the run `budget_exhausted`. This is
  ADR 0052's "declared decides" rule: the node's result chose the route, and
  an exhausted revise loop must not turn into an approval.
- **Cycles.** Value edges are graph edges for cycle detection, start-node
  inference and ADR 0053. A cycle closed by a value edge needs a budget like
  any other. A component with none is a load error. An elementary cycle left
  uncovered in a budgeted component is an `uncovered_cycle` warning, and its
  `edge.when` is the key form above.

### Load-time checks against outputs and schemas

After step inlining, so that a `uses:` node's step-declared `outputs:`
count (ADR 0054), every value edge is checked:

1. The path's key must be a declared `type: value` output of the `from`
   node. A missing key, or a `file`/`directory` output, is a load error.
2. When that output declares `schema:`, loading fails if the path cannot
   exist under it. Only the schema's direct keywords at each step are read:
   - a `false` schema;
   - a `type` that excludes `object` (for example `type: string` under
     `result.decision.kind`);
   - `additionalProperties: false` with no `properties` entry and no
     matching `patternProperties` pattern for the segment.

   JSON Schema keywords are conjunctive, so these rule a path out whatever
   `$ref`, `allOf` or `anyOf` add. A path that only those keywords could
   decide is accepted rather than proved impossible.
3. When the path ends at a schema with `const` or `enum`, every `equals`/`in`
   value must be allowed by it. A value the schema never admits could never
   match, so it is refused rather than left as a dead edge.
4. The ambiguity rule above.

**An edge does not require its key in the schema's `required`.** An edge on
`result.decision` loads whether or not `decision` is required. If it is
absent at run time the edge simply does not match and the node falls back.
An author who wants a missing decision to be a failure lists it in
`required`, and ADR 0054 then makes the node fail with
`output_schema_mismatch`. Making `required` mandatory would refuse
factories whose fallback is deliberate.

### Node-chosen routing: `routes:` and `next:` (designed here, built in SCARIFW-2252)

A node may declare the set of nodes its result is allowed to name:

```yaml
nodes:
  evaluate:
    uses: scarif:evaluate
    routes: [implement, checks_gate, { to: escalate, max_traversals: 1 }]
```

- Each `routes` entry is a node id, or `{ to: <id>, max_traversals: <n> }`.
- The runner gives the node a synthesized `type: value` output, `next`,
  whose schema is `{ enum: [<route ids>..., null] }` and which is never
  required. The node may not declare its own `next` output. The node writes
  `next.json` (or calls `mcp__minifac__report_next`) like any value output.
- **Routes are edges.** Each entry is treated as an edge
  `<node> → <to>` for every static rule: endpoint validation, start-node
  inference, cycle budgets (ADR 0053) and the viewer. Its traversal key is
  `<from>-><to>:route`.
- **Precedence: `next` > value edges > outcome edges.** On a success or a
  judged failure, a `next` naming a route takes that route alone. A `next`
  that is `null` or absent falls through to value edges, then to the
  outcome's literal edges, exactly as above. An `error` takes neither
  (ADR 0052).
- **An off-list `next` is a judged failure.** A `next` naming a node outside
  `routes` violates the synthesized schema, so ADR 0054 applies unchanged.
  The node ends `failed` with outcome `failure` and reason
  `output_schema_mismatch: output "next" ...`, the value is not indexed,
  and the node routes `on_failure`. No new failure reason is needed.
- A route taken is a traversal like any edge. `priorResults` carry across
  it unchanged, and the chosen `next` is in the node's indexed outputs in
  runs.db, so the path a run actually took is readable after the fact.

Expressed this way, `routes` adds nothing to the runner a value edge cannot
already do. `routes: [a, b]` behaves as two value edges on `next` (`equals:
a`, `equals: b`) that precede the node's other edges. The only additions are
the synthesized output and the precedence.

### #54's four questions

1. **Allow-list or budget? Both, for different jobs.** The allow-list makes
   every possible hop static, so the loader can check endpoints, find cycles
   and demand budgets, and the viewer can draw the graph. A budget alone
   would let a node route anywhere and leave nothing to check. The
   allow-list does not bound repetition, so a cycle through a route still
   needs `max_traversals` on a route entry or `max_iterations` on a node,
   per ADR 0053.
2. **Terminal reachability: no new rule.** The loader requires at least one
   `terminal: true` node and does not require every edge's target to reach
   one. Routes are edges, so they are held to exactly that. Adding a
   reachability rule for routes alone would make them stricter than the
   value edges they desugar to.
3. **Step-declared routes: not now, workflow only.** Node ids are scoped to
   the workflow, so a step cannot name `implement` without assuming the
   workflow that uses it. The deferred form is a step declaring route
   *names* that the workflow binds to node ids; it is recorded in
   [[Open-Questions]] with its trigger.
4. **`extends:` overrides: restate `routes`.** A derived layer that
   redeclares a node replaces it whole (`factory-schema`
   "Replace-at-node-level merge semantics"), so a layer that overrides a
   routing node must restate `routes`, or the node routes by edges only.
   Edges are replaced wholesale too, so a layer that changes a value edge
   restates the whole `edges:` list.

### Interactions, summarised

- **`on_error` (ADR 0052).** An error never takes a value edge or a route.
  A value that happens to match on an errored node is ignored, because an
  error carries no judgment.
- **Budgets (ADR 0053).** Value edges and routes are edges. Their traversal
  keys are as above, and a matched route or value edge that is exhausted
  does not fall back.
- **Output schemas (ADR 0054).** Load time rejects a path or value the
  schema rules out. At run time only an indexed (schema-valid) value can
  match, so a mismatched value matches nothing and the node routes
  `on_failure` as ADR 0054 already says. `required` is not demanded.

## Rejected alternatives

- **First match in declaration order.** Makes the route depend on how the
  YAML was ordered and hides real overlaps. The load-time overlap check
  removes the need for any order.
- **An outcome qualifier on value edges** (`when: { outcome: success,
  output: ..., equals: ... }`). It doubles the syntax for a case the
  verdict value already distinguishes, and a judged failure carrying a
  `decision` is the common verdict-node pattern.
- **A runtime ambiguity error** when two edges match. It turns a fan-out
  that is legal for `on_success` into a failure that only shows up on some
  inputs. The static same-path overlap check catches the likely mistake
  instead.
- **An expression language** (`when: "result.score > 0.8"`). It needs a
  parser, an evaluator and type rules, and it makes the load-time schema
  check undecidable. `equals`/`in` cover the verdict use case.
- **Falling back to outcome edges when a matched edge is exhausted.** It
  would let a spent revise loop route on to `on_success`, the failure mode
  ADR 0052 already rules out for `on_error`.
- **Requiring the tested key in `required`.** It would refuse deliberate
  fallback designs, and `required` already exists for authors who want it.

## Consequences

- A graph whose edges use only `on_success`, `on_failure` and `on_error`
  loads and routes exactly as before, and its edge keys are unchanged.
- `FactoryEdge["when"]` is now a union of the literals and a
  `ValueCondition` object. Embedders that treat `when` as a string need a
  branch for the object form.
- An older minifac refuses a factory with value edges, so roll back
  factories before rolling back minifac. For the same reason a run parked on
  a value-edge factory cannot be resumed on an older build. A run parked on
  an older build holds only outcome keys, which this build reads unchanged.
- There is no runs.db schema change.
- The serve viewer draws value edges in their own style, with the
  condition as a tooltip.

## Amendment (SCARIFW-2252, 2026-10-17)

SCARIFW-2252 built `routes:`/`next:` to the design above. Its acceptance
criteria depart from this record in two places, and its first criterion
says a departure amends the ADR in the same change. Everything else above
stands.

1. **Terminal reachability for route targets: a load error.** Question 2
   answered "no new rule". SCARIFW-2252 requires that "a `routes` entry
   that names no node, or that can't reach a terminal node, is a load
   error". The loader now refuses a route whose target has no path, along
   declared edges of any `when` and other routes, to a `terminal: true`
   node. A terminal target passes. The rule applies to routes only:
   declared edges, value edges included, are still held to the old rule.
   Routes are therefore stricter than the value edges they otherwise
   behave like. The reason is that a route is chosen at run time by a
   node's output, and a target that can never finish the run is almost
   certainly a mistake in the allow-list. Declared edges have no such
   check because nothing asked for one, and adding it there would refuse
   factories that load today.
2. **A routed hop is written to the run record.** "Routes add nothing to
   the runner a value edge cannot already do" no longer holds in one
   respect. SCARIFW-2252 asks that "the run record shows each routed hop as
   `chosen_by: <node id>`", so that log-reading tooling such as
   scarif-factory's `compare-runs.py` can follow a run's path without
   reading `next` outputs. Each route traversed now emits and persists a
   `runner-action` event, attributed to the routing node's dispatch, whose
   line is `route: node "<from>" chose "<to>" (chosen_by: <from>)` and
   whose payload carries `chosen_by` and `to`. It uses the existing events
   table, so there is still no runs.db schema change. A route that is
   chosen but budget-exhausted is not traversed and emits no event.

Two smaller points the design left open are settled here. `routes: []` is
refused, because its synthesized `next` could only be `null`. A value edge
may test the synthesized `next`; it is checked against the synthesized enum
like any value edge, and it is redundant with the route.

## Related

- [[0052-On-Error-Edges]], [[0053-Loop-Budgets-Per-Cycle]],
  [[0054-Step-Output-Schema]], [[0050-Iteration-Traversal-Tokens]],
  [[0048-Park-At-Node-Boundary]]
- [[Factory]], [[Runner]], [[Cycle]], [[Outputs]]
- twinsunllc/minifac#37, twinsunllc/minifac#54; SCARIFW-2251, SCARIFW-2252
