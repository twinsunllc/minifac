/**
 * `--filter` parser for `minifac autorun`. Two flavors:
 *
 *   - `/<pattern>/<flags?>` — regex literal; constructed with
 *     `new RegExp(pattern, flags)`.
 *   - any other non-empty string — glob translated to a regex that
 *     supports `*` (zero-or-more non-`/`) and `?` (one non-`/`).
 *
 * The filter is matched against the brief's `change` slug, not its file
 * path.
 */
export interface AutorunFilter {
  match(change: string): boolean;
}

export class AutorunFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutorunFilterError";
  }
}

const REGEX_FORM = /^\/(.+)\/([a-z]*)$/;

function globToRegex(glob: string): RegExp {
  let out = "^";
  for (const ch of glob) {
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      // Escape regex metacharacters.
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

export function parseAutorunFilter(expr: string): AutorunFilter {
  if (typeof expr !== "string" || expr.length === 0) {
    throw new AutorunFilterError("--filter expression must be a non-empty string");
  }
  const m = REGEX_FORM.exec(expr);
  if (m) {
    const [, pattern, flags] = m;
    try {
      const re = new RegExp(pattern ?? "", flags ?? "");
      return { match: (change: string) => re.test(change) };
    } catch (err) {
      throw new AutorunFilterError(
        `--filter regex \`${expr}\` is invalid: ${(err as Error).message}`,
      );
    }
  }
  const re = globToRegex(expr);
  return { match: (change: string) => re.test(change) };
}
