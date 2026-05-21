import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StepLoadError } from "./loader-error.js";
import { parseStepRef, resolveStepRef } from "./resolve.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-step-resolve-"));
  return dir;
}

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

const STEP = `name: foo
version: "1.0.0"
executor: claude
with: { prompt: "ok" }
`;

describe("parseStepRef", () => {
  it("parses minifac:<name>", () => {
    const r = parseStepRef("minifac:foo");
    expect(r.builtinForced).toBe(true);
    expect(r.name).toBe("foo");
    expect(r.scope).toBeUndefined();
    expect(r.version).toBeUndefined();
  });

  it("parses minifac:<name>@<version>", () => {
    const r = parseStepRef("minifac:foo@1.0.0");
    expect(r.builtinForced).toBe(true);
    expect(r.name).toBe("foo");
    expect(r.version).toBe("1.0.0");
  });

  it("parses <scope>/<name>", () => {
    const r = parseStepRef("acme/foo");
    expect(r.builtinForced).toBe(false);
    expect(r.scope).toBe("acme");
    expect(r.name).toBe("foo");
  });

  it("parses bare <name>", () => {
    const r = parseStepRef("foo");
    expect(r.builtinForced).toBe(false);
    expect(r.name).toBe("foo");
    expect(r.scope).toBeUndefined();
  });

  it("parses bare <name>@<version>", () => {
    const r = parseStepRef("foo@2");
    expect(r.builtinForced).toBe(false);
    expect(r.name).toBe("foo");
    expect(r.version).toBe("2");
  });

  it("rejects empty string", () => {
    expect(() => parseStepRef("")).toThrowError(StepLoadError);
  });

  it("rejects whitespace", () => {
    expect(() => parseStepRef("open spec")).toThrowError(/whitespace/);
  });

  it("rejects file extension", () => {
    expect(() => parseStepRef("foo.yaml")).toThrowError(/extension/);
  });

  it("rejects multiple slashes", () => {
    expect(() => parseStepRef("a/b/c")).toThrowError(/accepted/);
  });

  it("rejects empty version pin", () => {
    expect(() => parseStepRef("foo@")).toThrowError(/version/);
  });

  it("rejects path-like values", () => {
    expect(() => parseStepRef("./foo")).toThrowError();
    expect(() => parseStepRef("../foo")).toThrowError();
  });

  it("rejects invalid bare name", () => {
    expect(() => parseStepRef("1foo")).toThrowError(/name/);
  });
});

describe("resolveStepRef", () => {
  it("resolves minifac:<name> to examples/steps/<name>.yaml", async () => {
    const repo = await makeRepo();
    const file = await writeAt(repo, "examples/steps/foo.yaml", STEP);
    const result = await resolveStepRef("minifac:foo", repo);
    expect(result).toBe(file);
  });

  it("minifac:<name> skips local even when local exists", async () => {
    const repo = await makeRepo();
    await writeAt(repo, ".minifac/steps/foo.yaml", STEP);
    const builtin = await writeAt(repo, "examples/steps/foo.yaml", STEP);
    const result = await resolveStepRef("minifac:foo", repo);
    expect(result).toBe(builtin);
  });

  it("bare <name> prefers local over built-in", async () => {
    const repo = await makeRepo();
    const local = await writeAt(repo, ".minifac/steps/foo.yaml", STEP);
    await writeAt(repo, "examples/steps/foo.yaml", STEP);
    const result = await resolveStepRef("foo", repo);
    expect(result).toBe(local);
  });

  it("bare <name> falls back to built-in when local is missing", async () => {
    const repo = await makeRepo();
    const builtin = await writeAt(repo, "examples/steps/foo.yaml", STEP);
    const result = await resolveStepRef("foo", repo);
    expect(result).toBe(builtin);
  });

  it("throws on missing bare reference, names both paths", async () => {
    const repo = await makeRepo();
    await expect(resolveStepRef("nonexistent", repo)).rejects.toThrowError(
      /\.minifac\/steps\/nonexistent\.yaml.*examples\/steps\/nonexistent\.yaml/s,
    );
  });

  it("throws on missing minifac:<name> reference, names the one path", async () => {
    const repo = await makeRepo();
    await expect(resolveStepRef("minifac:nonexistent", repo)).rejects.toThrowError(
      /examples\/steps\/nonexistent\.yaml/,
    );
  });

  it("rejects path-like reference", async () => {
    const repo = await makeRepo();
    await expect(resolveStepRef("./steps/foo.yaml", repo)).rejects.toThrowError();
    await expect(resolveStepRef("../steps/foo", repo)).rejects.toThrowError();
  });

  it("rejects whitespace reference", async () => {
    const repo = await makeRepo();
    await expect(resolveStepRef("open spec foo", repo)).rejects.toThrowError(/whitespace/);
  });

  it("rejects empty pin", async () => {
    const repo = await makeRepo();
    await expect(resolveStepRef("minifac:foo@", repo)).rejects.toThrowError(/version/);
  });

  it("@1 and @1.0.0 parse and resolve the same as unversioned", async () => {
    const repo = await makeRepo();
    const builtin = await writeAt(repo, "examples/steps/foo.yaml", STEP);
    const a = await resolveStepRef("minifac:foo", repo);
    const b = await resolveStepRef("minifac:foo@1", repo);
    const c = await resolveStepRef("minifac:foo@1.0.0", repo);
    expect(a).toBe(builtin);
    expect(b).toBe(builtin);
    expect(c).toBe(builtin);
  });

  it("unversioned and pinned references resolve to the same file", async () => {
    const repo = await makeRepo();
    const builtin = await writeAt(repo, "examples/steps/foo.yaml", STEP);
    const a = await resolveStepRef("foo", repo);
    const b = await resolveStepRef("foo@1.0.0", repo);
    expect(a).toBe(builtin);
    expect(b).toBe(builtin);
  });
});
