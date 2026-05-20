import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunArgResolutionError, resolveRunArg } from "./resolve.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-resolve-"));
  await mkdir(path.join(dir, "examples"), { recursive: true });
  await mkdir(path.join(dir, ".minifac", "factories"), { recursive: true });
  await mkdir(path.join(dir, "inputs"), { recursive: true });
  return dir;
}

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

const FACTORY_BODY = `name: f
nodes:
  a:
    executor: claude
    terminal: true
edges: []
`;

function briefFor(factory: string): string {
  return `---
change: my-change
factory: ${factory}
---

Body text.
`;
}

describe("resolveRunArg", () => {
  it("bare factory name prefers .minifac/factories/<name>.yaml over examples/<name>.yaml", async () => {
    const repo = await makeRepo();
    const local = await writeAt(repo, ".minifac/factories/sdd.yaml", FACTORY_BODY);
    await writeAt(repo, "examples/sdd.yaml", FACTORY_BODY);
    const r = await resolveRunArg("sdd", repo);
    expect(r.kind).toBe("factory");
    if (r.kind === "factory") expect(r.factoryPath).toBe(local);
  });

  it("bare factory name falls back to examples/<name>.yaml when local is missing", async () => {
    const repo = await makeRepo();
    const example = await writeAt(repo, "examples/sdd.yaml", FACTORY_BODY);
    const r = await resolveRunArg("sdd", repo);
    expect(r.kind).toBe("factory");
    if (r.kind === "factory") expect(r.factoryPath).toBe(example);
  });

  it("brief's bare `factory:` prefers local custom over built-in", async () => {
    const repo = await makeRepo();
    const local = await writeAt(repo, ".minifac/factories/sdd.yaml", FACTORY_BODY);
    await writeAt(repo, "examples/sdd.yaml", FACTORY_BODY);
    await writeAt(repo, "inputs/foo.md", briefFor("sdd"));
    const r = await resolveRunArg("foo", repo);
    expect(r.kind).toBe("brief");
    if (r.kind === "brief") expect(r.factoryPath).toBe(local);
  });

  it("brief's `minifac:<name>` skips local lookup", async () => {
    const repo = await makeRepo();
    await writeAt(repo, ".minifac/factories/sdd.yaml", FACTORY_BODY);
    const example = await writeAt(repo, "examples/sdd.yaml", FACTORY_BODY);
    await writeAt(repo, "inputs/foo.md", briefFor("minifac:sdd"));
    const r = await resolveRunArg("foo", repo);
    expect(r.kind).toBe("brief");
    if (r.kind === "brief") expect(r.factoryPath).toBe(example);
  });

  it("brief's `minifac:<name>` with no matching built-in fails", async () => {
    const repo = await makeRepo();
    await writeAt(repo, ".minifac/factories/sdd.yaml", FACTORY_BODY);
    await writeAt(repo, "inputs/foo.md", briefFor("minifac:sdd"));
    await expect(resolveRunArg("foo", repo)).rejects.toThrowError(
      /minifac:sdd.*examples\/sdd\.yaml/s,
    );
  });

  it("missing-everywhere bare name returns a RunArgResolutionError naming both factory paths tried", async () => {
    const repo = await makeRepo();
    try {
      await resolveRunArg("nonexistent", repo);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunArgResolutionError);
      expect((err as Error).message).toMatch(/\.minifac\/factories\/nonexistent\.yaml/);
      expect((err as Error).message).toMatch(/examples\/nonexistent\.yaml/);
    }
  });
});
