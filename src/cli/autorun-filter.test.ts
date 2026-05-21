import { describe, expect, it } from "vitest";
import { AutorunFilterError, parseAutorunFilter } from "./autorun-filter.js";

describe("parseAutorunFilter", () => {
  it("matches a glob prefix", () => {
    const f = parseAutorunFilter("feat-*");
    expect(f.match("feat-foo")).toBe(true);
    expect(f.match("feat-")).toBe(true);
    expect(f.match("chore-baz")).toBe(false);
  });

  it("matches a glob suffix", () => {
    const f = parseAutorunFilter("*-cleanup");
    expect(f.match("api-cleanup")).toBe(true);
    expect(f.match("cleanup-api")).toBe(false);
  });

  it("matches with `?`", () => {
    const f = parseAutorunFilter("foo?");
    expect(f.match("foo1")).toBe(true);
    expect(f.match("foo")).toBe(false);
    expect(f.match("foo12")).toBe(false);
  });

  it("does not let `*` match across `/`", () => {
    const f = parseAutorunFilter("foo*");
    expect(f.match("foobar")).toBe(true);
    expect(f.match("foo/bar")).toBe(false);
  });

  it("matches a regex with anchors", () => {
    const f = parseAutorunFilter("/^foo$/");
    expect(f.match("foo")).toBe(true);
    expect(f.match("foobar")).toBe(false);
    expect(f.match("barfoo")).toBe(false);
  });

  it("matches a regex with flags", () => {
    const f = parseAutorunFilter("/foo/i");
    expect(f.match("FOO")).toBe(true);
    expect(f.match("foo")).toBe(true);
    expect(f.match("bar")).toBe(false);
  });

  it("throws for an invalid regex", () => {
    expect(() => parseAutorunFilter("/[unterminated/")).toThrow(AutorunFilterError);
  });

  it("rejects empty string", () => {
    expect(() => parseAutorunFilter("")).toThrow(AutorunFilterError);
  });

  it("escapes regex metacharacters in glob form", () => {
    const f = parseAutorunFilter("foo.bar");
    expect(f.match("foo.bar")).toBe(true);
    expect(f.match("fooXbar")).toBe(false);
  });
});
