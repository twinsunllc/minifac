// How the graph draws an edge, by its `when`. No DOM access, so a test can
// import it directly.

/**
 * @param {string | { output: string } | undefined} when
 * @returns {{ cls: string, marker: string }}
 */
export function edgeStyle(when) {
  // A value condition (ADR 0055) is an object, not a literal.
  if (typeof when === "object" && when !== null) {
    return { cls: "edge-path on-value", marker: "url(#arrow-value)" };
  }
  switch (when) {
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
