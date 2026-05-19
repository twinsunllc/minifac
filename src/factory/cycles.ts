import type { Factory } from "./schema.js";

/**
 * Tarjan's strongly connected components. Each returned component is a list of
 * node ids. A component is "cyclic" if it contains more than one node, OR it
 * is a single node with a self-loop edge.
 */
function tarjanSCCs(factory: Factory): string[][] {
  const nodeIds = Object.keys(factory.nodes);
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const edge of factory.edges) {
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

/**
 * Returns the cyclic SCCs whose budget coverage is missing. A cycle is
 * "covered" if any node in the SCC has `max_iterations`, OR any edge whose
 * both endpoints are in the SCC has `max_traversals`.
 */
export function findUncoveredCycles(factory: Factory): UncoveredCycle[] {
  const sccs = tarjanSCCs(factory);
  const uncovered: UncoveredCycle[] = [];

  for (const scc of sccs) {
    const sccSet = new Set(scc);
    const isCyclic =
      scc.length > 1 ||
      (scc.length === 1 &&
        factory.edges.some((e) => {
          const head = scc[0];
          return head !== undefined && e.from === head && e.to === head;
        }));
    if (!isCyclic) continue;

    const nodeCovered = scc.some((id) => {
      const n = factory.nodes[id];
      return n?.max_iterations !== undefined;
    });
    const edgeCovered = factory.edges.some(
      (e) => sccSet.has(e.from) && sccSet.has(e.to) && e.max_traversals !== undefined,
    );

    if (!nodeCovered && !edgeCovered) {
      uncovered.push({ nodes: scc });
    }
  }

  return uncovered;
}
