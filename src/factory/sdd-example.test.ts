import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadFactory } from "./loader.js";

const sddPath = path.resolve(__dirname, "..", "..", "examples", "sdd.yaml");

describe("examples/sdd.yaml", () => {
  it("loads without error", async () => {
    const loaded = await loadFactory(sddPath);
    expect(loaded.factory.name).toBe("sdd");
    expect(loaded.sourcePath).toBe(sddPath);
  });

  it("declares brief: required", async () => {
    const { factory } = await loadFactory(sddPath);
    expect(factory.brief).toBe("required");
  });

  it("uses brief template tokens, not the old <CHANGE_NAME> placeholder", async () => {
    const { factory } = await loadFactory(sddPath);
    const propose = factory.nodes.propose?.with?.prompt as string;
    expect(propose).toContain("{{ brief.change }}");
    expect(propose).toContain("{{ brief.body }}");
    for (const id of ["apply", "verify", "archive"] as const) {
      const p = factory.nodes[id]?.with?.prompt as string;
      expect(typeof p, `${id} prompt should be a string`).toBe("string");
      expect(p, `${id} prompt should reference brief.change`).toContain("{{ brief.change }}");
    }
    for (const [id, node] of Object.entries(factory.nodes)) {
      const p = node.with?.prompt;
      if (typeof p === "string") {
        expect(p, `${id} prompt should not contain <CHANGE_NAME>`).not.toContain("<CHANGE_NAME>");
      }
    }
  });

  it("declares exactly the four documented nodes", async () => {
    const { factory } = await loadFactory(sddPath);
    expect(new Set(Object.keys(factory.nodes))).toEqual(
      new Set(["propose", "apply", "verify", "archive"]),
    );
    for (const node of Object.values(factory.nodes)) {
      expect(node.executor).toBe("claude");
    }
  });

  it("declares exactly the four documented edges with correct when values", async () => {
    const { factory } = await loadFactory(sddPath);
    const edgeKeys = factory.edges.map((e) => `${e.from}->${e.to}:${e.when}`).sort();
    expect(edgeKeys).toEqual(
      [
        "propose->apply:on_success",
        "apply->verify:on_success",
        "verify->archive:on_success",
        "verify->apply:on_failure",
      ].sort(),
    );
  });

  it("makes archive the sole terminal node", async () => {
    const { factory } = await loadFactory(sddPath);
    expect(factory.nodes.archive?.terminal).toBe(true);
    for (const [id, node] of Object.entries(factory.nodes)) {
      if (id !== "archive") {
        expect(node.terminal).toBe(false);
      }
    }
  });

  it("bounds the verify→apply cycle with max_traversals: 3", async () => {
    const { factory } = await loadFactory(sddPath);
    const retry = factory.edges.find((e) => e.from === "verify" && e.to === "apply");
    expect(retry).toBeDefined();
    expect(retry?.when).toBe("on_failure");
    expect(retry?.max_traversals).toBe(3);
  });

  it("declares no other budgets", async () => {
    const { factory } = await loadFactory(sddPath);
    for (const edge of factory.edges) {
      const isRetry = edge.from === "verify" && edge.to === "apply";
      if (!isRetry) {
        expect(edge.max_traversals).toBeUndefined();
      }
    }
    for (const node of Object.values(factory.nodes)) {
      expect(node.max_iterations).toBeUndefined();
    }
  });

  it("resolves propose as the sole start node", async () => {
    const { factory } = await loadFactory(sddPath);
    // Replicate the loader's start-node logic inline: a start node is any
    // node with no `on_success` inbound edges. See src/factory/loader.ts
    // and openspec/specs/graph-runner/spec.md.
    const onSuccessInbound = new Set<string>();
    for (const edge of factory.edges) {
      if (edge.when === "on_success") onSuccessInbound.add(edge.to);
    }
    const startNodes = Object.keys(factory.nodes)
      .filter((id) => !onSuccessInbound.has(id))
      .sort();
    expect(startNodes).toEqual(["propose"]);
  });

  it("declares permission_mode: bypass_permissions on every node", async () => {
    const { factory } = await loadFactory(sddPath);
    for (const id of ["propose", "apply", "verify", "archive"] as const) {
      const node = factory.nodes[id];
      expect(node, `node ${id} should be defined`).toBeDefined();
      expect(node?.with?.permission_mode, `node ${id} permission_mode`).toBe("bypass_permissions");
    }
  });

  it("declares per-node success/failure criteria in prose", async () => {
    // Sentinel mechanics are the runner's job now — the factory only
    // declares what success and failure *mean* for each node. See
    // openspec/specs/node-executor/spec.md ("Status signaling via
    // sentinel marker") and openspec/specs/sdd-factory/spec.md
    // ("SDD factory prompts declare per-node success/failure criteria").
    const { factory } = await loadFactory(sddPath);
    const propose = factory.nodes.propose?.with?.prompt;
    expect(typeof propose, "propose prompt should be a string").toBe("string");
    expect(propose as string, "propose mentions openspec validate").toContain("openspec validate");

    const apply = factory.nodes.apply?.with?.prompt;
    expect(typeof apply, "apply prompt should be a string").toBe("string");
    expect(apply as string, "apply mentions tasks.md").toContain("tasks.md");

    const verify = factory.nodes.verify?.with?.prompt;
    expect(typeof verify, "verify prompt should be a string").toBe("string");
    expect(verify as string, "verify mentions verify command criterion").toContain("verify");

    const archive = factory.nodes.archive?.with?.prompt;
    expect(typeof archive, "archive prompt should be a string").toBe("string");
    expect(archive as string, "archive mentions openspec archive").toContain("openspec archive");
    expect(archive as string, "archive mentions git commit").toContain("git commit");
  });

  it('declares cwd: "{{ run.cwd }}" on every node (no hand-edited placeholder)', async () => {
    const { factory } = await loadFactory(sddPath);
    for (const id of ["propose", "apply", "verify", "archive"] as const) {
      const node = factory.nodes[id];
      expect(node, `node ${id} should be defined`).toBeDefined();
      expect(node?.cwd).toBe("{{ run.cwd }}");
    }
    for (const node of Object.values(factory.nodes)) {
      expect(node.cwd ?? "").not.toContain("/path/to/target/repo");
    }
  });

  it("pins the archive commit subject-line convention", async () => {
    const { factory } = await loadFactory(sddPath);
    const prompt = factory.nodes.archive?.with?.prompt;
    expect(typeof prompt, "archive prompt should be a string").toBe("string");
    expect(prompt as string, "archive prompt should mention Archive: subject").toContain(
      "Archive:",
    );
  });
});
