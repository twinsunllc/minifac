## 1. Decision

- [x] 1.1 Amend `docs/decisions/0055-Value-Edges-And-Node-Routing.md`:
      terminal reachability for route targets, the `chosen_by` event

## 2. Schema and load-time checks

- [x] 2.1 `src/factory/routes.ts`: `RouteEntrySchema`, `RoutesSchema`,
      `normalizeRoutes`, `routeEdges`, `graphEdges`, `routeEdgeKey`,
      `nextOutputDef`, `synthesizeRouteOutputs`, `validateRoutes`
- [x] 2.2 `src/factory/schema.ts`: `NodeSchema.routes`
- [x] 2.3 `src/step/inline.ts`: carry `routes` through inlining
- [x] 2.4 `src/factory/loader.ts`: `validateRoutes` and
      `synthesizeRouteOutputs` in `validatePostSchema`; the
      `uncovered_cycle` message for a route
- [x] 2.5 `src/factory/start-nodes.ts`, `src/factory/cycles.ts`: iterate
      `graphEdges`
- [x] 2.6 `src/factory/value-edges.ts`: `edgeWhenKey` accepts a route
- [x] 2.7 `src/index.ts`: export the helpers and types

## 3. Runtime

- [x] 3.1 `src/runner/run.ts`: `next` precedence, route key, resume over
      `graphEdges`, `chosen_by` runner-action event
- [x] 3.2 `src/executor/types.ts`: optional `chosen_by`/`to` on the
      runner-action event
- [x] 3.3 `src/runner/result.ts`, `src/runner/resume.ts`: key format docs

## 4. Viewer

- [x] 4.1 `src/serve/web/edge-style.js`, `app.js`, `style.css`: on-route
      style, marker, tooltip, layout

## 5. Tests

- [x] 5.1 `src/factory/routes.test.ts`: schema, synthesized `next`,
      declared-`next` refusal (node and step), load errors, start nodes,
      cycle budgets and warnings, `extends:`, `examples/routing.yaml`
- [x] 5.2 `src/runner/run.routes.test.ts`: precedence, off-list `next`,
      error, budgets and no-fallback, `{{ edge.traversals }}`,
      park/resume, persisted `chosen_by` event, the example's routed run
- [x] 5.3 `src/runner/mcp-server.test.ts`: `report_next` over the socket
- [x] 5.4 `src/serve/web-edge-style.test.ts`: on-route style, derived
      edges, tooltip

## 6. Docs

- [x] 6.1 `examples/routing.yaml`
- [x] 6.2 `docs/concepts/Factory.md`, `Runner.md`, `Cycle.md`,
      `Outputs.md`, `docs/Open-Questions.md`
- [x] 6.3 `CHANGELOG.md` `[Unreleased]`
