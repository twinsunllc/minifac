export type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export interface Route<H> {
  method: Method;
  /** Path pattern. Segments starting with `:` are params. */
  pattern: string;
  handler: H;
}

export interface RouteMatch<H> {
  handler: H;
  params: Record<string, string>;
}

export type MatchResult<H> =
  | { kind: "match"; match: RouteMatch<H> }
  | { kind: "method_not_allowed"; allowed: Method[] }
  | { kind: "not_found" };

interface Compiled<H> {
  method: Method;
  segments: Array<{ literal: string } | { param: string }>;
  handler: H;
}

export class Router<H> {
  private readonly routes: Compiled<H>[] = [];

  add(method: Method, pattern: string, handler: H): void {
    const segs = splitPath(pattern).map((s) =>
      s.startsWith(":") ? { param: s.slice(1) } : { literal: s },
    );
    this.routes.push({ method, segments: segs, handler });
  }

  match(method: string, pathname: string): MatchResult<H> {
    const parts = splitPath(pathname);
    const byShape = this.routes.filter((r) => r.segments.length === parts.length);
    const allowedByPath: Method[] = [];

    for (const r of byShape) {
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.segments.length; i++) {
        const seg = r.segments[i];
        const part = parts[i];
        if (seg === undefined || part === undefined) {
          ok = false;
          break;
        }
        if ("literal" in seg) {
          if (seg.literal !== part) {
            ok = false;
            break;
          }
        } else {
          params[seg.param] = decodeURIComponent(part);
        }
      }
      if (!ok) continue;
      if (r.method === method) {
        return { kind: "match", match: { handler: r.handler, params } };
      }
      if (!allowedByPath.includes(r.method)) allowedByPath.push(r.method);
    }

    if (allowedByPath.length > 0) {
      return { kind: "method_not_allowed", allowed: allowedByPath };
    }
    return { kind: "not_found" };
  }
}

function splitPath(p: string): string[] {
  const trimmed = p.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return [];
  return trimmed.split("/");
}
