import path from "node:path";
import { describe, expect, it } from "vitest";
import { getInlinedInputs } from "../step/inline.js";
import { loadFactory } from "./loader.js";

const sddPath = path.resolve(__dirname, "..", "..", "examples", "sdd.yaml");
const repoRoot = path.resolve(__dirname, "..", "..");

describe("examples/sdd.yaml", () => {
  it("loads without error", async () => {
    const loaded = await loadFactory(sddPath, repoRoot);
    expect(loaded.factory.name).toBe("sdd");
    expect(loaded.sourcePath).toBe(sddPath);
  });

  it("declares brief: required", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    expect(factory.brief).toBe("required");
  });

  it("resolved prompts have inputs folded in and carry brief tokens for dispatch-time substitution", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    const propose = factory.nodes.propose?.with?.prompt as string;
    expect(propose).toContain("{{ brief.change }}");
    expect(propose).toContain("{{ brief.body }}");
    for (const id of ["apply", "verify", "archive"] as const) {
      const p = factory.nodes[id]?.with?.prompt as string;
      expect(typeof p, `${id} prompt should be a string`).toBe("string");
      expect(p, `${id} prompt should reference brief.change`).toContain("{{ brief.change }}");
    }
    // The resolved inputs map still records the original brief tokens so
    // the dispatch-time pass can re-substitute when needed.
    for (const id of ["propose", "apply", "verify", "archive"] as const) {
      const node = factory.nodes[id];
      expect(node, `node ${id} should be defined`).toBeDefined();
      const inputs = getInlinedInputs(node as object);
      expect(inputs?.change).toBe("{{ brief.change }}");
    }
    expect(getInlinedInputs(factory.nodes.propose as object)?.brief_body).toBe("{{ brief.body }}");
  });

  it("no resolved claude prompt contains <CHANGE_NAME>, /path/to/target/repo, or MINIFAC_STATUS", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    for (const [id, node] of Object.entries(factory.nodes)) {
      if (node.executor !== "claude") continue;
      const p = node.with?.prompt;
      if (typeof p === "string") {
        expect(p, `${id} prompt should not contain <CHANGE_NAME>`).not.toContain("<CHANGE_NAME>");
        expect(p, `${id} prompt should not contain /path/to/target/repo`).not.toContain(
          "/path/to/target/repo",
        );
        expect(p, `${id} prompt should not contain MINIFAC_STATUS`).not.toContain("MINIFAC_STATUS");
      }
    }
  });

  it("declares exactly the five documented nodes with the right executor mix", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    expect(new Set(Object.keys(factory.nodes))).toEqual(
      new Set(["propose", "apply", "verify", "archive", "check-merge"]),
    );
    for (const id of ["propose", "apply", "verify", "archive"] as const) {
      expect(factory.nodes[id]?.executor, `${id} executor`).toBe("claude");
    }
    expect(factory.nodes["check-merge"]?.executor).toBe("check-merge");
  });

  it("declares exactly the five documented edges with correct when values", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    const edgeKeys = factory.edges.map((e) => `${e.from}->${e.to}:${e.when}`).sort();
    expect(edgeKeys).toEqual(
      [
        "propose->apply:on_success",
        "apply->verify:on_success",
        "verify->archive:on_success",
        "verify->apply:on_failure",
        "archive->check-merge:on_success",
      ].sort(),
    );
  });

  it("makes check-merge the sole terminal node; archive is no longer terminal", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    expect(factory.nodes["check-merge"]?.terminal).toBe(true);
    for (const [id, node] of Object.entries(factory.nodes)) {
      if (id !== "check-merge") {
        expect(node.terminal, `${id} terminal`).toBe(false);
      }
    }
  });

  it("check-merge resolves to the default with values", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    const node = factory.nodes["check-merge"];
    expect(node).toBeDefined();
    expect(node?.with?.base).toBe("{{ run.base_branch }}");
    expect(node?.with?.mode).toBe("any-merge");
    expect(node?.cwd).toBe("{{ run.cwd }}");
    const w = node?.with ?? {};
    expect(w).not.toHaveProperty("permission_mode");
    expect(w).not.toHaveProperty("allowed_tools");
    expect(w).not.toHaveProperty("add_dirs");
  });

  it("no edge exits check-merge (no on_failure routing in v0)", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    for (const edge of factory.edges) {
      expect(edge.from, "no edge should exit check-merge").not.toBe("check-merge");
    }
  });

  it("bounds the verify→apply cycle with max_traversals: 3", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    const retry = factory.edges.find((e) => e.from === "verify" && e.to === "apply");
    expect(retry).toBeDefined();
    expect(retry?.when).toBe("on_failure");
    expect(retry?.max_traversals).toBe(3);
  });

  it("declares no other budgets", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
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
    const { factory } = await loadFactory(sddPath, repoRoot);
    const onSuccessInbound = new Set<string>();
    for (const edge of factory.edges) {
      if (edge.when === "on_success") onSuccessInbound.add(edge.to);
    }
    const startNodes = Object.keys(factory.nodes)
      .filter((id) => !onSuccessInbound.has(id))
      .sort();
    expect(startNodes).toEqual(["propose"]);
  });

  it("declares permission_mode: bypass_permissions on every resolved node", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    for (const id of ["propose", "apply", "verify", "archive"] as const) {
      const node = factory.nodes[id];
      expect(node, `node ${id} should be defined`).toBeDefined();
      expect(node?.with?.permission_mode, `node ${id} permission_mode`).toBe("bypass_permissions");
    }
  });

  it("no resolved `with` declares allowed_tools or add_dirs", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    for (const [id, node] of Object.entries(factory.nodes)) {
      const w = node.with ?? {};
      expect(w, `${id} should not declare allowed_tools`).not.toHaveProperty("allowed_tools");
      expect(w, `${id} should not declare add_dirs`).not.toHaveProperty("add_dirs");
    }
  });

  it("declares per-node success/failure criteria in prose", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
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

  it('declares cwd: "{{ run.cwd }}" on every resolved node', async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    for (const id of ["propose", "apply", "verify", "archive", "check-merge"] as const) {
      const node = factory.nodes[id];
      expect(node, `node ${id} should be defined`).toBeDefined();
      expect(node?.cwd).toBe("{{ run.cwd }}");
    }
    for (const node of Object.values(factory.nodes)) {
      expect(node.cwd ?? "").not.toContain("/path/to/target/repo");
    }
  });

  it("pins the archive commit subject-line convention", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    const prompt = factory.nodes.archive?.with?.prompt;
    expect(typeof prompt, "archive prompt should be a string").toBe("string");
    expect(prompt as string, "archive prompt should mention Archive: subject").toContain(
      "Archive:",
    );
  });

  it("resolved nodes have no uses: or inputs: enumerated", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);
    for (const node of Object.values(factory.nodes)) {
      expect((node as { uses?: unknown }).uses).toBeUndefined();
      expect((node as { inputs?: unknown }).inputs).toBeUndefined();
    }
  });
});
