/**
 * Constructs the canonical nudge message the runner writes to an
 * executor's stdin when declared required outputs are missing after a
 * `succeeded` sentinel. See `docs/decisions/0028-Node-Outputs-Nudge.md`
 * and the `graph-runner` capability's "Post-execution nudge loop"
 * requirement.
 */

import type { NodeOutputType } from "../factory/schema.js";

export interface MissingOutput {
  /** The declared output key (e.g. `findings`). */
  key: string;
  /** The declared output type. */
  type: NodeOutputType;
  /** Absolute filesystem path the validator scanned. */
  expected_path: string;
  /** Optional detail string describing the specific failure mode
   * (e.g. `"parse error: unexpected end of input"`, `"ambiguous: ..."`,
   * `"empty"`). Omitted for the common "absent" case so the bullet
   * collapses to `- key (type: X): expected at <path>`. */
  detail?: string;
}

export function buildNudgeMessage(missing: readonly MissingOutput[]): string {
  const lines: string[] = [];
  lines.push("The following declared required outputs were not produced:");
  lines.push("");
  for (const m of missing) {
    const base = `  - ${m.key} (type: ${m.type}): expected at ${m.expected_path}`;
    if (m.detail !== undefined && m.detail.length > 0 && !isTrivialDetail(m.detail)) {
      lines.push(`${base} — ${m.detail}`);
    } else {
      lines.push(base);
    }
  }
  lines.push("");
  lines.push(
    "Please produce these outputs now. After they're written, emit MINIFAC_STATUS: succeeded (or MINIFAC_STATUS: failed with a REASON if you cannot produce them).",
  );
  return lines.join("\n");
}

/** A detail string is trivial when it adds no information beyond the
 * "the file is just not there" case. Such bullets collapse to the
 * key/type/path-only form per the design doc. */
function isTrivialDetail(detail: string): boolean {
  const d = detail.trim().toLowerCase();
  return d === "" || d === "absent" || d === "not found" || d === "missing";
}
