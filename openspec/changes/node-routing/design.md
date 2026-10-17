## Context

See `proposal.md` and `docs/decisions/0055-Value-Edges-And-Node-Routing.md`
("Node-chosen routing: `routes:` and `next:`", and the SCARIFW-2252
amendment).

## Decisions

- **One module.** `src/factory/routes.ts` holds the entry schema
  (`RouteEntrySchema`, `RoutesSchema`), normalization (`normalizeRoutes`),
  the derived edges (`routeEdges`, `graphEdges`), the key
  (`routeEdgeKey`), the synthesized output (`nextOutputDef`,
  `synthesizeRouteOutputs`) and the load checks (`validateRoutes`). Routes
  are never written into `factory.edges`, so embedders that read
  `factory.edges` see exactly what the YAML declared.
- **`GraphEdge`.** A declared edge or a route, whose `when` is the edge's
  `when` or the literal `"route"`. `edgeWhenKey` maps `"route"` to
  `route`, so the runner's single `edgeKey` builds `<from>-><to>:route`.
  `start-nodes.ts` and the three analyses in `cycles.ts` iterate
  `graphEdges(factory)`, which is `factory.edges` itself when no node
  declares routes.
- **Where the load checks run.** In `validatePostSchema`, after the
  declared edges' endpoint check and before start-node inference:
  `validateRoutes` (endpoints, then terminal reachability over all graph
  edges of any `when`), then `synthesizeRouteOutputs`, which runs before
  `validateValueEdges` so a value edge on `next` is checked against the
  synthesized enum. Both run after step inlining, so a step-declared
  `next` output is seen. `inlineStepIntoNode` carries `routes` through
  like `start` and `resume`.
- **Runner.** After a success or a judged failure, the runner reads `next`
  from the node's indexed (schema-valid) outputs. A string naming one of
  the node's routes replaces the selection with that single route edge;
  anything else leaves the value-edge and outcome selection unchanged. The
  budget loop is unchanged, so a chosen route that is exhausted is skipped
  with no fallback. Resume reads `edgeTraversals` keys and `via` against
  `graphEdges`, so `:route` keys survive a park.
- **Run record.** A traversed route emits a `runner-action` event
  `route: node "<from>" chose "<to>" (chosen_by: <from>)` with `chosen_by`
  and `to` in the payload, persisted through the existing events table.
- **Viewer.** `routeEdgesOf` derives route edges from the factory payload's
  nodes; `edgeStyle("route")` draws `edge-path on-route` with its own
  marker and the tooltip `route (chosen by <from>)`. Forward routes take
  part in layout like forward value edges, and right-to-left edges bow
  below the row.
- **Empty `routes: []`** is refused: it would synthesize an output whose
  only value is `null`, which does nothing.
