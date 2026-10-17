// How the graph draws an edge, by its `when`. No DOM access, so a test can
// import it directly.

/**
 * @param {string | undefined} when
 * @returns {{ cls: string, marker: string }}
 */
export function edgeStyle(when) {
  switch (when) {
    case "on_failure":
      return { cls: "edge-path on-failure", marker: "url(#arrow-fail)" };
    case "on_error":
      return { cls: "edge-path on-error", marker: "url(#arrow-error)" };
    default:
      return { cls: "edge-path", marker: "url(#arrow)" };
  }
}
