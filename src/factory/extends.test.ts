import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installRoot } from "../packaging/install-root.js";
import { FactoryLoadError, loadFactory } from "./loader.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-extends-"));
  await mkdir(path.join(dir, "examples"), { recursive: true });
  await mkdir(path.join(dir, ".minifac", "factories"), { recursive: true });
  return dir;
}

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

const VALID_BASE = `name: base
description: a base
brief: required
nodes:
  propose:
    executor: claude
    with: { prompt: original-propose }
  apply:
    executor: claude
    terminal: true
    with: { prompt: original-apply }
edges:
  - from: propose
    to: apply
`;

describe("extends chain resolution", () => {
  it("loads a factory without `extends:` unchanged (regression)", async () => {
    const repo = await makeRepo();
    const file = await writeAt(repo, "examples/plain.yaml", VALID_BASE);
    const loaded = await loadFactory(file, repo);
    expect(loaded.factory.name).toBe("base");
    expect(Object.keys(loaded.factory.nodes)).toEqual(["propose", "apply"]);
    expect("extends" in loaded.factory).toBe(false);
  });

  it("resolves `extends: minifac:<name>` to examples/<name>.yaml", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/base.yaml", VALID_BASE);
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      "extends: minifac:base\n",
    );
    const loaded = await loadFactory(derived, repo);
    expect(loaded.factory.name).toBe("base");
    expect(loaded.factory.nodes.propose?.with?.prompt).toBe("original-propose");
  });

  it("resolves bare `extends: <name>` to .minifac/factories/<name>.yaml", async () => {
    const repo = await makeRepo();
    await writeAt(repo, ".minifac/factories/midbase.yaml", VALID_BASE);
    const derived = await writeAt(repo, ".minifac/factories/derived.yaml", "extends: midbase\n");
    const loaded = await loadFactory(derived, repo);
    expect(loaded.factory.name).toBe("base");
  });

  it("throws when minifac:<name> base is missing, citing the entry-point file", async () => {
    const repo = await makeRepo();
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      "extends: minifac:does-not-exist\n",
    );
    await expect(loadFactory(derived, repo)).rejects.toThrowError(
      /minifac:does-not-exist.*examples\/does-not-exist\.yaml/s,
    );
    try {
      await loadFactory(derived, repo);
    } catch (err) {
      expect(err).toBeInstanceOf(FactoryLoadError);
      expect((err as FactoryLoadError).sourcePath).toBe(derived);
    }
  });

  it("throws when local <name> base is missing, citing the entry-point file", async () => {
    const repo = await makeRepo();
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      "extends: missing-local\n",
    );
    await expect(loadFactory(derived, repo)).rejects.toThrowError(
      /missing-local.*\.minifac\/factories\/missing-local\.yaml/s,
    );
  });

  it("rejects cyclic extends chains (a → b → a)", async () => {
    const repo = await makeRepo();
    await writeAt(repo, ".minifac/factories/a.yaml", `extends: b\n${VALID_BASE}`);
    await writeAt(repo, ".minifac/factories/b.yaml", `extends: a\n${VALID_BASE}`);
    const entry = path.join(repo, ".minifac", "factories", "a.yaml");
    await expect(loadFactory(entry, repo)).rejects.toThrowError(/[Cc]yclic.*a\.yaml/);
  });

  it("rejects a self-referential extends", async () => {
    const repo = await makeRepo();
    const file = await writeAt(
      repo,
      ".minifac/factories/self.yaml",
      `extends: self\n${VALID_BASE}`,
    );
    await expect(loadFactory(file, repo)).rejects.toThrowError(/[Cc]yclic/);
  });

  it("rejects path-like extends values", async () => {
    const repo = await makeRepo();
    const file = await writeAt(
      repo,
      ".minifac/factories/bad.yaml",
      `extends: ../other/foo.yaml\n${VALID_BASE}`,
    );
    await expect(loadFactory(file, repo)).rejects.toThrowError(
      /only `minifac:<name>` and bare `<name>` forms/,
    );
  });

  it("replace-at-node-level: override one node, others preserved verbatim", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/base.yaml", VALID_BASE);
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:base
nodes:
  apply:
    executor: claude
    terminal: true
    with: { prompt: overridden-apply }
`,
    );
    const loaded = await loadFactory(derived, repo);
    expect(Object.keys(loaded.factory.nodes).sort()).toEqual(["apply", "propose"]);
    expect(loaded.factory.nodes.propose?.with?.prompt).toBe("original-propose");
    expect(loaded.factory.nodes.apply?.with?.prompt).toBe("overridden-apply");
  });

  it("derived layer can add a new node", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/base.yaml", VALID_BASE);
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:base
nodes:
  audit:
    executor: claude
    with: { prompt: new-audit }
`,
    );
    const loaded = await loadFactory(derived, repo);
    expect(loaded.factory.nodes.audit?.with?.prompt).toBe("new-audit");
    expect(loaded.factory.nodes.propose).toBeDefined();
  });

  it("derived layer's `edges:` replaces base edges wholesale", async () => {
    const repo = await makeRepo();
    await writeAt(
      repo,
      "examples/base.yaml",
      `name: base
nodes:
  a:
    executor: claude
  b:
    executor: claude
  c:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
  - from: b
    to: c
`,
    );
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:base
edges:
  - from: a
    to: c
`,
    );
    const loaded = await loadFactory(derived, repo);
    expect(loaded.factory.edges).toHaveLength(1);
    expect(loaded.factory.edges[0]?.from).toBe("a");
    expect(loaded.factory.edges[0]?.to).toBe("c");
  });

  it("derived layer omitting `edges:` inherits base edges unchanged", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/base.yaml", VALID_BASE);
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:base
nodes:
  apply:
    executor: claude
    terminal: true
    with: { prompt: tweak }
`,
    );
    const loaded = await loadFactory(derived, repo);
    expect(loaded.factory.edges).toHaveLength(1);
    expect(loaded.factory.edges[0]?.from).toBe("propose");
  });

  it("derived layer can override top-level name, description, brief", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/base.yaml", VALID_BASE);
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:base
name: derived-name
description: a derived factory
brief: optional
`,
    );
    const loaded = await loadFactory(derived, repo);
    expect(loaded.factory.name).toBe("derived-name");
    expect(loaded.factory.description).toBe("a derived factory");
    expect(loaded.factory.brief).toBe("optional");
  });

  it("derived layer omitting top-level fields inherits them from the base", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/base.yaml", VALID_BASE);
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:base
`,
    );
    const loaded = await loadFactory(derived, repo);
    expect(loaded.factory.name).toBe("base");
    expect(loaded.factory.description).toBe("a base");
    expect(loaded.factory.brief).toBe("required");
  });

  it("resolved factory has no `extends` property", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/base.yaml", VALID_BASE);
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      "extends: minifac:base\n",
    );
    const loaded = await loadFactory(derived, repo);
    expect("extends" in loaded.factory).toBe(false);
  });

  it("post-schema validation runs against the resolved factory", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/base.yaml", VALID_BASE);
    // Override removes terminal from apply (the only terminal node).
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:base
nodes:
  apply:
    executor: claude
    with: { prompt: still-here }
`,
    );
    try {
      await loadFactory(derived, repo);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FactoryLoadError);
      const fe = err as FactoryLoadError;
      expect(fe.message).toMatch(/terminal/i);
      expect(fe.sourcePath).toBe(derived);
    }
  });

  it("rejects empty-string extends value", async () => {
    const repo = await makeRepo();
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: ""\n${VALID_BASE}`,
    );
    await expect(loadFactory(derived, repo)).rejects.toThrowError(/extends/);
  });

  it("extends: minifac:<name> hits the install root when bundled", async () => {
    // The install root ships examples/sdd.yaml; resolve through it without
    // any source-tree fallback file present. The bundled factory's name
    // is "sdd" — observing that name proves we loaded the install-root file.
    const repo = await makeRepo();
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      "extends: minifac:sdd\n",
    );
    const loaded = await loadFactory(derived, repo);
    expect(loaded.factory.name).toBe("sdd");
    // And the bundled propose node is present, sourced from the install root.
    expect(loaded.factory.nodes.propose).toBeDefined();
    // `installRoot()` referenced to lock in the import for the test below;
    // direct chain inspection is not exposed by loadFactory.
    expect(installRoot()).toMatch(/minifac/);
  });

  it("extends: minifac:<name> falls back to source-tree examples when install root misses", async () => {
    const repo = await makeRepo();
    // `not-bundled` is not at install root; the callerCwd examples/ wins.
    await writeAt(repo, "examples/not-bundled.yaml", VALID_BASE);
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      "extends: minifac:not-bundled\n",
    );
    const loaded = await loadFactory(derived, repo);
    // VALID_BASE has `name: base` — confirms we loaded the fallback.
    expect(loaded.factory.name).toBe("base");
  });

  it("extends: minifac:<name> missing in both names both paths in order", async () => {
    const repo = await makeRepo();
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      "extends: minifac:nonexistent-base\n",
    );
    const installCandidate = path.join(installRoot(), "examples", "nonexistent-base.yaml");
    const localCandidate = path.join(repo, "examples", "nonexistent-base.yaml");
    await expect(loadFactory(derived, repo)).rejects.toThrowError(
      new RegExp(`${installCandidate}.*${localCandidate}`, "s"),
    );
  });

  it("bare extends: <name> does not consult the install root", async () => {
    // Even though the install root ships `examples/sdd.yaml`, a bare
    // `extends: sdd` MUST resolve only against the local
    // .minifac/factories tree — install root is reserved for `minifac:`.
    const repo = await makeRepo();
    const derived = await writeAt(repo, ".minifac/factories/derived.yaml", "extends: sdd\n");
    await expect(loadFactory(derived, repo)).rejects.toThrowError(
      /\.minifac\/factories\/sdd\.yaml/,
    );
  });

  it("derived layer override replaces the node wholesale (including outputs)", async () => {
    const repo = await makeRepo();
    await writeAt(
      repo,
      "examples/with-outputs.yaml",
      `name: base
nodes:
  propose:
    executor: claude
    with: { prompt: original-propose }
    outputs:
      findings: { type: value, required: true }
  apply:
    executor: claude
    terminal: true
    with: { prompt: original-apply }
edges:
  - from: propose
    to: apply
`,
    );
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:with-outputs
nodes:
  propose:
    executor: claude
    with: { prompt: overridden-propose }
`,
    );
    const loaded = await loadFactory(derived, repo);
    // Whole-node replace: derived's propose has no outputs, so the
    // base's outputs are gone.
    expect(loaded.factory.nodes.propose?.outputs).toBeUndefined();
    expect(loaded.factory.nodes.propose?.with?.prompt).toBe("overridden-propose");
  });
});
