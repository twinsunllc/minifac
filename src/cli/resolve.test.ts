import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBrief } from "../brief/loader.js";
import { BriefCycleError } from "../brief/state.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import { RunArgResolutionError, gateBriefDeps, resolveRunArg } from "./resolve.js";

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

async function freshStore(): Promise<SqliteRunStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-gate-db-"));
  return SqliteRunStore.open(path.join(dir, "runs.db"));
}

function brief(change: string, depends_on: string[] = []): string {
  const deps =
    depends_on.length === 0 ? "" : `depends_on:\n${depends_on.map((d) => `  - ${d}`).join("\n")}\n`;
  return `---\nchange: ${change}\nfactory: sdd\n${deps}---\nbody\n`;
}

describe("gateBriefDeps", () => {
  it("proceeds when there are no deps", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "inputs/foo.md", brief("foo"));
    const b = await loadBrief("foo", repo);
    const store = await freshStore();
    try {
      const r = await gateBriefDeps({ brief: b, runStore: store, cwd: repo });
      expect(r.kind).toBe("proceed");
    } finally {
      await store.close();
    }
  });

  it("refuses when a dep is active", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "inputs/foo.md", brief("foo", ["bar"]));
    await writeAt(repo, "inputs/bar.md", brief("bar"));
    const b = await loadBrief("foo", repo);
    const store = await freshStore();
    try {
      const r = await gateBriefDeps({ brief: b, runStore: store, cwd: repo });
      expect(r.kind).toBe("refuse");
      if (r.kind === "refuse") {
        expect(r.message).toMatch(/bar.*active/);
      }
    } finally {
      await store.close();
    }
  });

  it("refuses when a dep is missing", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "inputs/foo.md", brief("foo", ["bar"]));
    const b = await loadBrief("foo", repo);
    const store = await freshStore();
    try {
      const r = await gateBriefDeps({ brief: b, runStore: store, cwd: repo });
      expect(r.kind).toBe("refuse");
      if (r.kind === "refuse") {
        expect(r.message).toMatch(/bar.*missing/);
      }
    } finally {
      await store.close();
    }
  });

  it("proceeds when deps are done", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "inputs/foo.md", brief("foo", ["bar"]));
    await writeAt(repo, "inputs/done/bar.md", brief("bar"));
    const b = await loadBrief("foo", repo);
    const store = await freshStore();
    try {
      const r = await gateBriefDeps({ brief: b, runStore: store, cwd: repo });
      expect(r.kind).toBe("proceed");
    } finally {
      await store.close();
    }
  });

  it("--force converts refuse to warn", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "inputs/foo.md", brief("foo", ["bar"]));
    await writeAt(repo, "inputs/bar.md", brief("bar"));
    const b = await loadBrief("foo", repo);
    const store = await freshStore();
    try {
      const r = await gateBriefDeps({ brief: b, runStore: store, cwd: repo, force: true });
      expect(r.kind).toBe("warn");
      if (r.kind === "warn") {
        expect(r.message).toMatch(/bar.*active/);
      }
    } finally {
      await store.close();
    }
  });

  it("throws BriefCycleError on cycle (regardless of --force)", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "inputs/foo.md", brief("foo", ["bar"]));
    await writeAt(repo, "inputs/bar.md", brief("bar", ["foo"]));
    const b = await loadBrief("foo", repo);
    const store = await freshStore();
    try {
      await expect(
        gateBriefDeps({ brief: b, runStore: store, cwd: repo, force: true }),
      ).rejects.toBeInstanceOf(BriefCycleError);
    } finally {
      await store.close();
    }
  });
});
