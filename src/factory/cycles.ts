import { type GraphEdge, graphEdges } from "./routes.js";
import type { Factory } from "./schema.js";
import { startNodeIds } from "./start-nodes.js";
import { edgeWhenKey } from "./value-edges.js";

/**
 * Tarjan's strongly connected components over {@link graphEdges} (declared
 * edges and routes). Each returned component is a list of node ids. A component is "cyclic" if it contains more than one node, OR it
 * is a single node with a self-loop edge.
 */
function tarjanSCCs(factory: Factory): string[][] {
  const nodeIds = Object.keys(factory.nodes);
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const edge of graphEdges(factory)) {
    adj.get(edge.from)?.push(edge.to);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongconnect = (v: string): void => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v) ?? 0, lowlinks.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v) ?? 0, indices.get(w) ?? 0));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const component: string[] = [];
      while (true) {
        const w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      sccs.push(component);
    }
  };

  for (const id of nodeIds) {
    if (!indices.has(id)) strongconnect(id);
  }

  return sccs;
}

export interface UncoveredCycle {
  nodes: string[];
}

export interface EntryCycle {
  nodes: string[];
}

/**
 * Returns the cyclic SCCs that no edge enters from outside the component.
 * When a factory has no start node, every node has an inbound edge from
 * another node, so the graph can only be entered through such a cycle —
 * these are the components the load error names, because one node in each
 * is where `start: true` belongs.
 */
export function findEntryCycles(factory: Factory): EntryCycle[] {
  const edges = graphEdges(factory);
  const entries: EntryCycle[] = [];
  for (const scc of tarjanSCCs(factory)) {
    if (scc.length < 2) continue;
    const members = new Set(scc);
    const entered = edges.some((e) => members.has(e.to) && !members.has(e.from));
    if (!entered) entries.push({ nodes: [...scc].reverse() });
  }
  return entries;
}

/**
 * Returns the cyclic SCCs whose budget coverage is missing. A cycle is
 * "covered" if any node in the SCC has `max_iterations`, OR any edge (or
 * route) whose both endpoints are in the SCC has `max_traversals`.
 */
export function findUncoveredCycles(factory: Factory): UncoveredCycle[] {
  const edges = graphEdges(factory);
  const sccs = tarjanSCCs(factory);
  const uncovered: UncoveredCycle[] = [];

  for (const scc of sccs) {
    const sccSet = new Set(scc);
    const isCyclic =
      scc.length > 1 ||
      (scc.length === 1 &&
        edges.some((e) => {
          const head = scc[0];
          return head !== undefined && e.from === head && e.to === head;
        }));
    if (!isCyclic) continue;

    const nodeCovered = scc.some((id) => {
      const n = factory.nodes[id];
      return n?.max_iterations !== undefined;
    });
    const edgeCovered = edges.some(
      (e) => sccSet.has(e.from) && sccSet.has(e.to) && e.max_traversals !== undefined,
    );

    if (!nodeCovered && !edgeCovered) {
      uncovered.push({ nodes: scc });
    }
  }

  return uncovered;
}

export interface UnbudgetedCycle {
  /** The cycle's nodes in traversal order, starting at the node the edge to cap enters. */
  nodes: string[];
  /** The edge that closes the cycle; adding `max_traversals` to it covers the
   *  cycle. `when` is the edge's key form ({@link edgeWhenKey}). */
  edge: { from: string; to: string; when: string };
}

/**
 * Returns elementary cycles that carry no budget, per ADR 0053. An
 * elementary cycle is covered when one of its edges has `max_traversals`
 * (of any `when`, a route's included) or one of its nodes has
 * `max_iterations`. Every cycle is
 * covered exactly when the residual graph — the factory without budgeted
 * edges and without `max_iterations` nodes — is acyclic, so no cycle
 * enumeration is needed.
 *
 * Each residual cycle is found as a back-edge of a depth-first search whose
 * roots are the start nodes and then every other node, in declaration
 * order, following edges in declaration order. That back-edge is the edge
 * reported to cap. It is then dropped from the residual graph and the
 * search repeated, so the result is complete: adding `max_traversals` to
 * every reported edge leaves no uncovered cycle.
 *
 * Cycles inside an SCC that {@link findUncoveredCycles} reports (no budget
 * anywhere in the component) are not repeated here; that case is a load
 * error of its own.
 */
export function findUnbudgetedCycles(factory: Factory): UnbudgetedCycle[] {
  const hardError = new Set(findUncoveredCycles(factory).flatMap((c) => c.nodes));
  const residualNode = (id: string): boolean =>
    factory.nodes[id] !== undefined &&
    factory.nodes[id]?.max_iterations === undefined &&
    !hardError.has(id);

  // Edge indices into `edges` (declared edges, then routes), so parallel
  // edges between the same pair (different `when`) stay distinct.
  const edges = graphEdges(factory);
  const live = new Set<number>();
  edges.forEach((e, i) => {
    if (e.max_traversals === undefined && residualNode(e.from) && residualNode(e.to)) live.add(i);
  });

  const nodeIds = Object.keys(factory.nodes);
  const starts = startNodeIds(factory);
  const roots = [...starts, ...nodeIds.filter((id) => !starts.includes(id))].filter(residualNode);

  const out: UnbudgetedCycle[] = [];
  for (;;) {
    const found = firstBackEdge(edges, roots, live);
    if (found === undefined) return out;
    live.delete(found.edgeIndex);
    const edge = edges[found.edgeIndex];
    if (edge === undefined) return out;
    out.push({
      nodes: found.nodes,
      edge: { from: edge.from, to: edge.to, when: edgeWhenKey(edge) },
    });
  }
}

/**
 * Depth-first search over the live edges. Returns the first back-edge met
 * (an edge into a node still on the DFS path) with the path segment it
 * closes, or undefined when the live graph is acyclic.
 */
function firstBackEdge(
  edges: GraphEdge[],
  roots: string[],
  live: Set<number>,
): { edgeIndex: number; nodes: string[] } | undefined {
  const outEdges = new Map<string, number[]>();
  for (const i of live) {
    const e = edges[i];
    if (e === undefined) continue;
    const list = outEdges.get(e.from) ?? [];
    list.push(i);
    outEdges.set(e.from, list);
  }
  for (const list of outEdges.values()) list.sort((a, b) => a - b);

  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const visit = (v: string): { edgeIndex: number; nodes: string[] } | undefined => {
    path.push(v);
    onPath.add(v);
    for (const i of outEdges.get(v) ?? []) {
      const w = edges[i]?.to;
      if (w === undefined || done.has(w)) continue;
      if (onPath.has(w)) return { edgeIndex: i, nodes: path.slice(path.indexOf(w)) };
      const found = visit(w);
      if (found) return found;
    }
    path.pop();
    onPath.delete(v);
    done.add(v);
    return undefined;
  };

  for (const root of roots) {
    if (done.has(root)) continue;
    const found = visit(root);
    if (found) return found;
  }
  return undefined;
}
