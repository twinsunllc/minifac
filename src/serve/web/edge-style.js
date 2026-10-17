// How the graph draws an edge, by its `when`. No DOM access, so a test can
// import it directly.

/**
 * `when` is an outcome literal, a value condition, or `"route"` for an edge
 * derived from a node's `routes:` ({@link routeEdgesOf}).
 *
 * @param {string | { output: string } | undefined} when
 * @returns {{ cls: string, marker: string }}
 */
export function edgeStyle(when) {
  // A value condition (ADR 0055) is an object, not a literal.
  if (typeof when === "object" && when !== null) {
    return { cls: "edge-path on-value", marker: "url(#arrow-value)" };
  }
  switch (when) {
    case "route":
      return { cls: "edge-path on-route", marker: "url(#arrow-route)" };
    case "on_failure":
      return { cls: "edge-path on-failure", marker: "url(#arrow-fail)" };
    case "on_error":
      return { cls: "edge-path on-error", marker: "url(#arrow-error)" };
    default:
      return { cls: "edge-path", marker: "url(#arrow)" };
  }
}

/**
 * The tooltip text for a value edge, e.g. `result.decision = "revise"`;
 * null for an outcome edge.
 *
 * @param {string | { output: string, equals?: unknown, in?: unknown[] } | undefined} when
 * @returns {string | null}
 */
export function valueConditionText(when) {
  if (typeof when !== "object" || when === null) return null;
  return when.in !== undefined
    ? `${when.output} in ${JSON.stringify(when.in)}`
    : `${when.output} = ${JSON.stringify(when.equals)}`;
}

/**
 * Every node's `routes:` (ADR 0055) as edges with `when: "route"`, in node
 * then entry order. A route entry is a node id or `{ to, max_traversals }`.
 *
 * @param {Record<string, { routes?: Array<string | { to: string }> }>} nodes
 * @returns {Array<{ from: string, to: string, when: "route" }>}
 */
export function routeEdgesOf(nodes) {
  const out = [];
  for (const [from, node] of Object.entries(nodes || {})) {
    for (const entry of node?.routes || []) {
      out.push({ from, to: typeof entry === "string" ? entry : entry.to, when: "route" });
    }
  }
  return out;
}

/**
 * The tooltip text for an edge: `route (chosen by <from>)` for a route, the
 * condition for a value edge, null for an outcome edge.
 *
 * @param {{ from: string, when?: string | { output: string, equals?: unknown, in?: unknown[] } }} edge
 * @returns {string | null}
 */
export function edgeTooltip(edge) {
  if (edge.when === "route") return `route (chosen by ${edge.from})`;
  return valueConditionText(edge.when);
}
