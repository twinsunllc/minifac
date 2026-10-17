import { z } from "zod";
import { FactoryLoadError } from "./loader-error.js";
import type { EdgeWhen, Factory, FactoryEdge, FactoryNode, OutputValueDef } from "./schema.js";

/**
 * Node-chosen routing (ADR 0055, built in SCARIFW-2252). A node may declare
 * the nodes its result is allowed to name:
 *
 *   routes: [implement, checks_gate, { to: escalate, max_traversals: 1 }]
 *
 * The loader gives a routing node a synthesized `type: value` output `next`
 * whose schema is `{ enum: [<route ids>..., null] }`. Every entry is an edge
 * `<node> → <to>` for the static rules (endpoints, start nodes, cycle
 * budgets, the viewer); routes are never written into `factory.edges`, so
 * those rules read {@link graphEdges} instead.
 */

const PositiveInt = z.number().int().positive();

export const RouteEntrySchema = z.union(
  [
    z.string().min(1, "a route must name a node"),
    z
      .object({
        to: z.string().min(1, "a route must name a node"),
        max_traversals: PositiveInt.optional(),
      })
      .strict(),
  ],
  {
    // Reached only when neither form fits the value's type (a number, a
    // list); a mapping with a bad key or budget reports the object form's
    // own issue.
    errorMap: (issue, ctx) =>
      issue.code === z.ZodIssueCode.invalid_union
        ? { message: "a route must be a node id or { to: <id>, max_traversals: <n> }" }
        : { message: ctx.defaultError },
  },
);

export const RoutesSchema = z
  .array(RouteEntrySchema)
  .min(1, "routes must list at least one node")
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const [i, entry] of entries.entries()) {
      const to = typeof entry === "string" ? entry : entry.to;
      if (seen.has(to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate route "${to}"; each node may be listed once`,
          path: [i],
        });
      }
      seen.add(to);
    }
  });

export type RouteEntry = z.infer<typeof RouteEntrySchema>;

/** A route entry in its object form. */
export interface Route {
  to: string;
  max_traversals?: number;
}

/** The `when` a route edge carries, and the suffix of its traversal key. */
export const ROUTE_WHEN = "route";

/**
 * An edge for the static graph rules and the runner: a declared edge, or a
 * route (`when: "route"`) derived from a node's `routes:`.
 */
export type GraphEdge = Omit<FactoryEdge, "when"> & { when: EdgeWhen | typeof ROUTE_WHEN };

/** A node's `routes:` in object form, in declaration order; `[]` without any. */
export function normalizeRoutes(node: Pick<FactoryNode, "routes">): Route[] {
  return (node.routes ?? []).map((entry) => (typeof entry === "string" ? { to: entry } : entry));
}

/** Every node's routes as edges, in node then entry declaration order. */
export function routeEdges(factory: Factory): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const [from, node] of Object.entries(factory.nodes)) {
    for (const route of normalizeRoutes(node)) {
      const edge: GraphEdge = { from, to: route.to, when: ROUTE_WHEN };
      if (route.max_traversals !== undefined) edge.max_traversals = route.max_traversals;
      out.push(edge);
    }
  }
  return out;
}

/**
 * The declared edges followed by the route edges. A factory without
 * `routes:` yields exactly `factory.edges`, in the same order.
 */
export function graphEdges(factory: Factory): GraphEdge[] {
  const routes = routeEdges(factory);
  return routes.length === 0 ? factory.edges : [...factory.edges, ...routes];
}

/** A route's traversal key, `<from>-><to>:route`. */
export function routeEdgeKey(from: string, to: string): string {
  return `${from}->${to}:${ROUTE_WHEN}`;
}

/** The output key a routing node's choice is written to. */
export const NEXT_OUTPUT = "next";

/** The synthesized `next` output for `routes`. */
export function nextOutputDef(routes: Route[]): OutputValueDef {
  return {
    type: "value",
    required: false,
    description:
      "The node to run next: one of this node's routes, or null to follow its edges (ADR 0055).",
    schema: { enum: [...routes.map((r) => r.to), null] },
  };
}

/**
 * Give every routing node its `next` output. Runs after step inlining, so an
 * output a `uses:` node took from its step counts: a routing node that
 * already has a `next` output, declared on the node or by its step, is a
 * load error.
 */
export function synthesizeRouteOutputs(factory: Factory, sourcePath: string): void {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    const routes = normalizeRoutes(node);
    if (routes.length === 0) continue;
    if (node.outputs !== undefined && Object.hasOwn(node.outputs, NEXT_OUTPUT)) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`routes:\` and also has an output "${NEXT_OUTPUT}" (declared on the node or by its step); a routing node's "${NEXT_OUTPUT}" output is synthesized from its routes, so it may not declare one`,
        sourcePath,
      );
    }
    node.outputs = { ...node.outputs, [NEXT_OUTPUT]: nextOutputDef(routes) };
  }
}

/**
 * Load-time checks on every `routes` entry. Throws on the first:
 *
 *   1. the entry names no declared node;
 *   2. no path of edges or routes leads from the entry's node to a
 *      `terminal: true` node (SCARIFW-2252, amending ADR 0055 question 2).
 */
export function validateRoutes(factory: Factory, sourcePath: string): void {
  const nodeIds = new Set(Object.keys(factory.nodes));
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    for (const [i, route] of normalizeRoutes(node).entries()) {
      if (!nodeIds.has(route.to)) {
        throw new FactoryLoadError(
          `Node "${nodeId}" routes entry "${route.to}" (routes[${i}]) names no declared node`,
          sourcePath,
        );
      }
    }
  }

  const reachesTerminal = nodesReachingTerminal(factory);
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    for (const [i, route] of normalizeRoutes(node).entries()) {
      if (!reachesTerminal.has(route.to)) {
        throw new FactoryLoadError(
          `Node "${nodeId}" routes entry "${route.to}" (routes[${i}]) cannot reach a terminal node: no path of edges or routes leads from "${route.to}" to a node marked \`terminal: true\``,
          sourcePath,
        );
      }
    }
  }
}

/** Nodes with a path (any `when`, routes included) to a terminal node, terminals included. */
function nodesReachingTerminal(factory: Factory): Set<string> {
  const inbound = new Map<string, string[]>();
  for (const edge of graphEdges(factory)) {
    const list = inbound.get(edge.to) ?? [];
    list.push(edge.from);
    inbound.set(edge.to, list);
  }
  const reached = new Set(
    Object.keys(factory.nodes).filter((id) => factory.nodes[id]?.terminal === true),
  );
  const pending = [...reached];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const from of inbound.get(id) ?? []) {
      if (reached.has(from)) continue;
      reached.add(from);
      pending.push(from);
    }
  }
  return reached;
}
