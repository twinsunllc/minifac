import type { Factory } from "./schema.js";

/**
 * The nodes the runner dispatches when a run begins.
 *
 * A node is a start node when it has **no inbound edge from another node**
 * — of any kind. `on_failure` edges count: a node reachable only through a
 * recovery edge is an escalation / wait / re-poll target, and dispatching
 * it at run start would run it before the failure it exists to handle
 * (issue #36; scarif-factory FINDINGS F6). A self-loop is not an inbound
 * edge for this purpose: it cannot make the node reachable from anywhere
 * else, so a node whose only inbound edge is its own retry loop still
 * starts.
 *
 * `start: true` on a node is the explicit override for a node that has
 * inbound edges but must also start at run begin (an entry node inside a
 * cycle). See `docs/decisions/0040-Declared-Start-Nodes.md`.
 *
 * Order follows the factory's node declaration order — the same order the
 * runner has always used to seed its queue.
 */
export function startNodeIds(factory: Factory): string[] {
  const inbound = new Set<string>();
  for (const edge of factory.edges) {
    if (edge.from !== edge.to) inbound.add(edge.to);
  }
  return Object.keys(factory.nodes).filter(
    (id) => factory.nodes[id]?.start === true || !inbound.has(id),
  );
}
