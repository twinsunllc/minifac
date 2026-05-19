import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactoryLoadError, loadFactory } from "./loader.js";

const tmpDirs: string[] = [];

async function writeFactory(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-test-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

afterEach(() => {
  // cleanup is best-effort; test dirs are in tmp and won't leak meaningfully
});

describe("loadFactory", () => {
  it("loads a minimal valid factory", async () => {
    const file = await writeFactory(
      "ok.yaml",
      `name: simple
nodes:
  a:
    executor: claude
    terminal: true
edges: []
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.name).toBe("simple");
    expect(loaded.factory.nodes.a?.executor).toBe("claude");
    expect(loaded.factory.nodes.a?.terminal).toBe(true);
    expect(loaded.factory.edges).toEqual([]);
    expect(loaded.sourcePath).toBe(file);
    expect(loaded.sourceDir).toBe(path.dirname(file));
  });

  it("rejects camelCase keys", async () => {
    const file = await writeFactory(
      "camel.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    terminal: true
    maxIterations: 3
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/maxIterations/);
  });

  it("rejects a node missing executor", async () => {
    const file = await writeFactory(
      "noexec.yaml",
      `name: bad
nodes:
  a:
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/executor/);
  });

  it("rejects unknown top-level node keys", async () => {
    const file = await writeFactory(
      "extra.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    terminal: true
    retry: 3
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/retry/);
  });

  it("accepts opaque `with:`", async () => {
    const file = await writeFactory(
      "with.yaml",
      `name: ok
nodes:
  a:
    executor: claude
    terminal: true
    with:
      prompt: hello
      anything: { nested: true }
edges: []
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.nodes.a?.with).toEqual({
      prompt: "hello",
      anything: { nested: true },
    });
  });

  it("rejects edges referencing undeclared `to`", async () => {
    const file = await writeFactory(
      "badedge.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    terminal: true
edges:
  - from: a
    to: ghost
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/ghost/);
  });

  it("rejects unknown `when` value", async () => {
    const file = await writeFactory(
      "badwhen.yaml",
      `name: bad
nodes:
  a:
    executor: claude
  b:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
    when: on_weekend
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/when/);
  });

  it("rejects unbounded cycles", async () => {
    // a is a start node (no on_success inbound); b loops back on_failure
    // with no budget on either the edge or a node in the cycle.
    const file = await writeFactory(
      "cycle.yaml",
      `name: cyc
nodes:
  a:
    executor: claude
  b:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
  - from: b
    to: a
    when: on_failure
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/cycle/i);
  });

  it("accepts cycles covered by an edge max_traversals", async () => {
    const file = await writeFactory(
      "ok-cycle.yaml",
      `name: cyc-ok
nodes:
  a:
    executor: claude
  b:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
  - from: b
    to: a
    max_traversals: 3
    when: on_failure
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.name).toBe("cyc-ok");
  });

  it("accepts cycles covered by a node max_iterations", async () => {
    const file = await writeFactory(
      "ok-cycle-node.yaml",
      `name: cyc-ok-node
nodes:
  a:
    executor: claude
    max_iterations: 3
  b:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
  - from: b
    to: a
    when: on_failure
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.nodes.a?.max_iterations).toBe(3);
  });

  it("rejects factories with no terminal node", async () => {
    const file = await writeFactory(
      "noterm.yaml",
      `name: bad
nodes:
  a:
    executor: claude
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/terminal/i);
  });

  it("rejects factories with no start node", async () => {
    // closed loop of two nodes — both have inbound, neither is a start node
    const file = await writeFactory(
      "nostart.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    max_iterations: 2
  b:
    executor: claude
    terminal: true
    max_iterations: 2
edges:
  - from: a
    to: b
  - from: b
    to: a
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/start/i);
  });

  it("reports a line number for malformed YAML", async () => {
    // Unterminated flow mapping → genuine YAML parse error with line info.
    const file = await writeFactory(
      "broken.yaml",
      `name: broken
nodes:
  a:
    executor: claude
    terminal: true
edges: []
extra: { open
`,
    );
    try {
      await loadFactory(file);
      throw new Error("expected loadFactory to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FactoryLoadError);
      const fe = err as FactoryLoadError;
      // The yaml parser surfaces a line number; the wrapped error includes it.
      expect(fe.location?.line).toBeGreaterThan(0);
    }
  });

  it("reports a clear error when the file is missing", async () => {
    await expect(
      loadFactory(path.join(tmpdir(), "no-such-minifac-factory-xyz.yaml")),
    ).rejects.toThrowError(/Could not read/);
  });
});
