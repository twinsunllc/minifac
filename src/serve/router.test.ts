import { describe, expect, it } from "vitest";
import { Router } from "./router.js";

describe("Router", () => {
  it("matches a literal GET path", () => {
    const r = new Router<string>();
    r.add("GET", "/api/factories", "list");
    const m = r.match("GET", "/api/factories");
    expect(m.kind).toBe("match");
    if (m.kind === "match") {
      expect(m.match.handler).toBe("list");
      expect(m.match.params).toEqual({});
    }
  });

  it("extracts :param segments", () => {
    const r = new Router<string>();
    r.add("GET", "/api/runs/:id", "get-run");
    const m = r.match("GET", "/api/runs/abc-123");
    expect(m.kind).toBe("match");
    if (m.kind === "match") {
      expect(m.match.params).toEqual({ id: "abc-123" });
    }
  });

  it("handles multiple params and trailing literal segment", () => {
    const r = new Router<string>();
    r.add("GET", "/api/runs/:id/events", "events");
    const m = r.match("GET", "/api/runs/xyz/events");
    expect(m.kind).toBe("match");
    if (m.kind === "match") {
      expect(m.match.handler).toBe("events");
      expect(m.match.params.id).toBe("xyz");
    }
  });

  it("returns method_not_allowed when path matches but method differs", () => {
    const r = new Router<string>();
    r.add("GET", "/api/factories", "list");
    const m = r.match("PUT", "/api/factories");
    expect(m.kind).toBe("method_not_allowed");
    if (m.kind === "method_not_allowed") {
      expect(m.allowed).toContain("GET");
    }
  });

  it("returns not_found for an unknown path", () => {
    const r = new Router<string>();
    r.add("GET", "/api/factories", "list");
    const m = r.match("GET", "/api/nope");
    expect(m.kind).toBe("not_found");
  });

  it("path is case-sensitive on literal segments", () => {
    const r = new Router<string>();
    r.add("GET", "/api/factories", "list");
    expect(r.match("GET", "/api/Factories").kind).toBe("not_found");
  });

  it("treats trailing slash as identical", () => {
    const r = new Router<string>();
    r.add("GET", "/api/factories", "list");
    expect(r.match("GET", "/api/factories/").kind).toBe("match");
  });

  it("decodes percent-encoded params", () => {
    const r = new Router<string>();
    r.add("GET", "/api/runs/:id", "get");
    const m = r.match("GET", "/api/runs/hello%2Fworld");
    expect(m.kind).toBe("match");
    if (m.kind === "match") {
      expect(m.match.params.id).toBe("hello/world");
    }
  });
});
