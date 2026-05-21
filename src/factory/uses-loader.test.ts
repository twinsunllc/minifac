import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FactoryLoadError, loadFactory } from "./loader.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-uses-"));
  await mkdir(path.join(dir, "examples", "steps"), { recursive: true });
  return dir;
}

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

const PROPOSE_STEP = `name: openspec-propose
version: "1.0.0"
executor: claude
inputs:
  change: { type: string, required: true }
with:
  permission_mode: "bypass_permissions"
  prompt: "Propose {{ inputs.change }}"
`;

const VERIFY_STEP = `name: openspec-verify
version: "1.0.0"
executor: claude
inputs:
  change: { type: string, required: true }
  commands: { type: array, default: ["npm test"] }
with:
  prompt: "Verify {{ inputs.change }}"
`;

describe("loadFactory with uses:", () => {
  it("loads a node with uses: and inputs:", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/openspec-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  propose:
    uses: minifac:openspec-propose
    inputs:
      change: "foo"
    terminal: true
edges: []
`,
    );
    const { factory } = await loadFactory(fac, repo);
    const node = factory.nodes.propose;
    expect(node?.executor).toBe("claude");
    expect(node?.with).toEqual({
      permission_mode: "bypass_permissions",
      prompt: "Propose {{ inputs.change }}",
    });
    expect((node as { uses?: unknown }).uses).toBeUndefined();
    expect((node as { inputs?: unknown }).inputs).toBeUndefined();
    expect(node?.terminal).toBe(true);
  });

  it("loads a node with uses: and no inputs: when defaults satisfy", async () => {
    const repo = await makeRepo();
    await writeAt(
      repo,
      "examples/steps/x.yaml",
      `name: x
version: "1"
executor: claude
with: { prompt: hi }
`,
    );
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:x
    terminal: true
edges: []
`,
    );
    const { factory } = await loadFactory(fac, repo);
    expect(factory.nodes.a?.executor).toBe("claude");
  });

  it("rejects node with both uses: and executor:", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/openspec-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:openspec-propose
    executor: claude
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError(/mutually exclusive/);
  });

  it("rejects node with both uses: and with:", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/openspec-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:openspec-propose
    with: { permission_mode: "bypass_permissions" }
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError(/mutually exclusive/);
  });

  it("rejects node with inputs: but no uses:", async () => {
    const repo = await makeRepo();
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    executor: claude
    inputs: { change: "foo" }
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError(/inputs/);
  });

  it("rejects node with neither uses: nor executor:", async () => {
    const repo = await makeRepo();
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError(/executor/);
  });

  it("rejects node with empty uses:", async () => {
    const repo = await makeRepo();
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: ""
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError();
  });

  it("rejects node with non-string uses:", async () => {
    const repo = await makeRepo();
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: 42
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError();
  });

  it("preserves node-level terminal, cwd alongside uses:", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/openspec-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:openspec-propose
    inputs: { change: foo }
    terminal: true
    cwd: "{{ run.cwd }}"
edges: []
`,
    );
    const { factory } = await loadFactory(fac, repo);
    expect(factory.nodes.a?.terminal).toBe(true);
    expect(factory.nodes.a?.cwd).toBe("{{ run.cwd }}");
  });

  it("rejects unknown node-level key alongside uses:", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/openspec-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:openspec-propose
    retry: 3
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError(/retry/);
  });

  it("resolved factory has no uses: or inputs: on any node", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/openspec-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:openspec-propose
    inputs: { change: foo }
    terminal: true
edges: []
`,
    );
    const { factory } = await loadFactory(fac, repo);
    for (const node of Object.values(factory.nodes)) {
      expect((node as { uses?: unknown }).uses).toBeUndefined();
      expect((node as { inputs?: unknown }).inputs).toBeUndefined();
    }
  });

  it("extends-based step layering: derived layer's uses: resolves the step at the derived layer", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/openspec-propose.yaml", PROPOSE_STEP);
    await writeAt(repo, "examples/steps/openspec-verify.yaml", VERIFY_STEP);
    // base declares verify inline
    await writeAt(
      repo,
      "examples/base.yaml",
      `name: base
nodes:
  propose:
    executor: claude
    with: { prompt: inline-propose }
  verify:
    executor: claude
    terminal: true
    with: { prompt: inline-verify }
edges:
  - from: propose
    to: verify
`,
    );
    // derived overrides verify to a step
    const derived = await writeAt(
      repo,
      ".minifac/factories/derived.yaml",
      `extends: minifac:base
nodes:
  verify:
    uses: minifac:openspec-verify
    inputs: { change: "foo" }
    terminal: true
`,
    );
    const { factory } = await loadFactory(derived, repo);
    expect(factory.nodes.verify?.executor).toBe("claude");
    expect((factory.nodes.verify?.with as { prompt: string }).prompt).toBe("Verify {{ inputs.change }}");
    expect((factory.nodes.propose?.with as { prompt: string }).prompt).toBe("inline-propose");
  });

  it("missing step file rejected at load with FactoryLoadError", async () => {
    const repo = await makeRepo();
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:nonexistent
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toBeInstanceOf(FactoryLoadError);
  });

  it("step inlining runs before post-schema validation", async () => {
    // Factory whose only terminal is the step-inlined node. Ensures
    // post-schema validation runs against the resolved factory.
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/openspec-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:openspec-propose
    inputs: { change: foo }
    terminal: true
edges: []
`,
    );
    // Should NOT throw — terminal is preserved by node-level fields.
    const { factory } = await loadFactory(fac, repo);
    expect(factory.nodes.a?.terminal).toBe(true);
  });
});
