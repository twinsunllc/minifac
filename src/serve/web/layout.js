// Where the graph puts its nodes and how it curves its edges. No DOM access,
// so a test can import it directly.

import { valueConditionText } from "./edge-style.js";

/** How far apart, in px, two edges between the same pair are drawn. */
const LANE_GAP = 22;

/**
 * The SVG path for an edge from `a` to `b`. `lane` is the edge's index among
 * the edges between the same pair ({@link edgeLanes}): lane 0 is the plain
 * curve, and each further lane pulls the curve's control point further out,
 * perpendicular to the line between the nodes, so parallel edges (a route
 * and an outcome edge between one pair) do not lie on top of each other.
 *
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @param {number} [lane]
 * @returns {string}
 */
export function edgePath(a, b, lane = 0) {
  // Simple curved path so back-edges don't lie on top of forward edges.
  if (a.x === b.x && a.y === b.y) return "";
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mx = a.x + dx / 2;
  const my = a.y + dy / 2;
  const offset = dy < 0 ? -30 : 0; // pull back-edges out a bit
  // A right-to-left edge (a loop back to an earlier column) bows below the
  // row, further the more columns it spans, so it does not lie on the
  // forward edges between the same nodes.
  const bow = dx < 0 ? 30 + Math.abs(dx) / 6 : 0;
  // Unit normal to a→b, scaled by the lane.
  const len = Math.hypot(dx, dy);
  const nx = lane === 0 ? 0 : (-dy / len) * lane * LANE_GAP;
  const ny = lane === 0 ? 0 : (dx / len) * lane * LANE_GAP;
  return `M${a.x},${a.y} Q${mx + offset + nx},${my + bow + ny} ${b.x},${b.y}`;
}

/**
 * Each edge's lane: its index among the edges, in order, that share its
 * `from` and `to`. An edge with no parallel gets lane 0.
 *
 * @param {Array<{ from: string, to: string }>} edges
 * @returns {number[]}
 */
export function edgeLanes(edges) {
  const seen = new Map();
  return edges.map((e) => {
    const key = `${e.from}\u0000${e.to}`;
    const lane = seen.get(key) ?? 0;
    seen.set(key, lane + 1);
    return lane;
  });
}

/**
 * Lay the graph out in columns: a node's column is the longest path to it
 * from a source, over the edges accepted for layout.
 *
 * On_success edges are accepted first. Then each value edge (ADR 0055) and
 * route, in order, is accepted only if its target does not already reach its
 * source over the edges accepted so far; otherwise it closes a cycle (a
 * revise loop) and is a back-edge, skipped for layout. So a cycle closed only
 * by value edges or routes gets one back-edge too, not just one closed by an
 * on_success edge. On_failure / on_error edges are ignored for layout.
 *
 * @param {string[]} nodes
 * @param {Array<{ from: string, to: string, when?: unknown }>} edges
 * @returns {{ pos: Record<string, { x: number, y: number }>, width: number, height: number }}
 */
export function layered(nodes, edges) {
  const out = new Map(nodes.map((n) => [n, []]));
  const inAccepted = new Map(nodes.map((n) => [n, []]));
  const accept = (e) => {
    out.get(e.from)?.push(e.to);
    inAccepted.get(e.to)?.push(e.from);
  };
  const reaches = (from, to) => {
    const seen = new Set();
    const stack = [from];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(out.get(id) || []));
    }
    return false;
  };
  for (const e of edges) if (e.when === "on_success") accept(e);
  for (const e of edges) {
    if (valueConditionText(e.when) === null && e.when !== "route") continue;
    if (!reaches(e.to, e.from)) accept(e);
  }
  const level = new Map();
  const visiting = new Set();
  const visit = (id) => {
    if (level.has(id)) return level.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let max = 0;
    for (const p of inAccepted.get(id) || []) {
      max = Math.max(max, visit(p) + 1);
    }
    visiting.delete(id);
    level.set(id, max);
    return max;
  };
  for (const id of nodes) visit(id);

  const byLevel = new Map();
  for (const id of nodes) {
    const l = level.get(id) || 0;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l).push(id);
  }
  const maxLevel = Math.max(0, ...byLevel.keys());
  const colW = 140;
  const rowH = 70;
  const width = (maxLevel + 1) * colW + 40;
  const maxPerLevel = Math.max(1, ...[...byLevel.values()].map((a) => a.length));
  const height = maxPerLevel * rowH + 40;
  const pos = {};
  for (const [l, ids] of byLevel.entries()) {
    ids.sort();
    const startY = (height - ids.length * rowH) / 2 + rowH / 2;
    ids.forEach((id, i) => {
      pos[id] = { x: 20 + l * colW + 50, y: startY + i * rowH };
    });
  }
  return { pos, width, height };
}
