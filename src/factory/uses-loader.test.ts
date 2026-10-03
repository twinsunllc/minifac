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

const PROPOSE_STEP = `name: myfac-propose
version: "1.0.0"
executor: claude
inputs:
  change: { type: string, required: true }
with:
  permission_mode: "bypass_permissions"
  prompt: "Propose {{ inputs.change }}"
`;

const VERIFY_STEP = `name: myfac-verify
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
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  propose:
    uses: minifac:myfac-propose
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
      prompt: "Propose foo",
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
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:myfac-propose
    executor: claude
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError(/mutually exclusive/);
  });

  it("rejects node with both uses: and with:", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:myfac-propose
    with: { permission_mode: "bypass_permissions" }
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError(/mutually exclusive/);
  });

  describe("uses: with `with: { secrets }` (ADR 0046)", () => {
    const SECRETS_STEP = `name: impl
version: "1.0.0"
executor: claude
with:
  prompt: "Implement it"
  permission_mode: "bypass_permissions"
`;

    function facWith(withYaml: string): string {
      return `name: f
nodes:
  implement:
    uses: minifac:impl
    with: ${withYaml}
    terminal: true
edges: []
`;
    }

    async function expectRefusal(repo: string, fac: string, pattern: RegExp): Promise<string> {
      const err = await loadFactory(fac, repo).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FactoryLoadError);
      const message = (err as Error).message;
      expect(message).toContain('Node "implement"');
      expect(message).toMatch(pattern);
      // One sentence: no sentence break inside the message.
      expect(message).not.toMatch(/[.!?]\s/);
      return message;
    }

    it("accepts a local step and merges the declared list into the resolved `with`", async () => {
      const repo = await makeRepo();
      await writeAt(repo, "examples/steps/impl.yaml", SECRETS_STEP);
      const fac = await writeAt(
        repo,
        "fac.yaml",
        facWith("{ secrets: [A_TOKEN, { name: B_TOKEN, via: proxy }] }"),
      );
      const { factory } = await loadFactory(fac, repo);
      const node = factory.nodes.implement;
      expect(node?.executor).toBe("claude");
      expect(node?.with).toEqual({
        prompt: "Implement it",
        permission_mode: "bypass_permissions",
        secrets: ["A_TOKEN", { name: "B_TOKEN", via: "proxy" }],
      });
      expect((node as { uses?: unknown }).uses).toBeUndefined();
      expect((node as { inputs?: unknown }).inputs).toBeUndefined();
    });

    it("accepts a factory-repo root `steps/` step", async () => {
      const repo = await makeRepo();
      await writeAt(repo, "factory.yaml", "name: c\n");
      await writeAt(repo, "steps/impl.yaml", SECRETS_STEP);
      const fac = await writeAt(
        repo,
        "workflows/w.yaml",
        `name: w
nodes:
  implement:
    uses: impl
    with: { secrets: [PAY_KEY] }
    terminal: true
edges: []
`,
      );
      const { factory } = await loadFactory(fac, repo);
      expect(factory.nodes.implement?.with?.secrets).toEqual(["PAY_KEY"]);
      expect(factory.nodes.implement?.with?.prompt).toBe("Implement it");
    });

    it("accepts an empty secrets list and merges it as empty", async () => {
      const repo = await makeRepo();
      await writeAt(repo, "examples/steps/impl.yaml", SECRETS_STEP);
      const fac = await writeAt(repo, "fac.yaml", facWith("{ secrets: [] }"));
      const { factory } = await loadFactory(fac, repo);
      expect(factory.nodes.implement?.with?.secrets).toEqual([]);
    });

    it("refuses any other key beside `uses:`, alone or next to secrets", async () => {
      for (const [withYaml, key] of [
        ['{ permission_mode: "bypass_permissions" }', "permission_mode"],
        ["{ prompt: y }", "prompt"],
        ["{ secrets: [A_TOKEN], model: z }", "model"],
      ] as const) {
        const repo = await makeRepo();
        await writeAt(repo, "examples/steps/impl.yaml", SECRETS_STEP);
        const fac = await writeAt(repo, "fac.yaml", facWith(withYaml));
        const message = await expectRefusal(repo, fac, /mutually exclusive/);
        expect(message).toContain(`(${key})`);
      }
    });

    it("refuses when the step already declares secrets, even an equal list", async () => {
      for (const declared of ["[A_TOKEN]", "[B_TOKEN]"]) {
        const repo = await makeRepo();
        await writeAt(repo, "examples/steps/impl.yaml", `${SECRETS_STEP}  secrets: [A_TOKEN]\n`);
        const fac = await writeAt(repo, "fac.yaml", facWith(`{ secrets: ${declared} }`));
        const message = await expectRefusal(repo, fac, /already declares `secrets`/);
        expect(message).toContain("impl.yaml");
      }
    });

    it("refuses an empty `with: {}`", async () => {
      const repo = await makeRepo();
      await writeAt(repo, "examples/steps/impl.yaml", SECRETS_STEP);
      const fac = await writeAt(repo, "fac.yaml", facWith("{}"));
      await expectRefusal(repo, fac, /empty `with:`/);
    });

    it("refuses a non-list `with.secrets`", async () => {
      for (const value of ["A_TOKEN", "{ name: A_TOKEN }", "null"]) {
        const repo = await makeRepo();
        await writeAt(repo, "examples/steps/impl.yaml", SECRETS_STEP);
        const fac = await writeAt(repo, "fac.yaml", facWith(`{ secrets: ${value} }`));
        await expectRefusal(repo, fac, /is not a list/);
      }
    });

    it("refuses a non-mapping `with:`", async () => {
      const repo = await makeRepo();
      await writeAt(repo, "examples/steps/impl.yaml", SECRETS_STEP);
      const fac = await writeAt(repo, "fac.yaml", facWith("x"));
      const err = await loadFactory(fac, repo).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FactoryLoadError);
      expect((err as Error).message).toContain("implement");
    });
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
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:myfac-propose
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
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:myfac-propose
    retry: 3
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(fac, repo)).rejects.toThrowError(/retry/);
  });

  it("resolved factory has no uses: or inputs: on any node", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:myfac-propose
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
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    await writeAt(repo, "examples/steps/myfac-verify.yaml", VERIFY_STEP);
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
    uses: minifac:myfac-verify
    inputs: { change: "foo" }
    terminal: true
`,
    );
    const { factory } = await loadFactory(derived, repo);
    expect(factory.nodes.verify?.executor).toBe("claude");
    expect((factory.nodes.verify?.with as { prompt: string }).prompt).toBe("Verify foo");
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
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  a:
    uses: minifac:myfac-propose
    inputs: { change: foo }
    terminal: true
edges: []
`,
    );
    // Should NOT throw — terminal is preserved by node-level fields.
    const { factory } = await loadFactory(fac, repo);
    expect(factory.nodes.a?.terminal).toBe(true);
  });

  it("preserves `resume:` through step inlining and leaves the step body untouched", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    await writeAt(repo, "examples/steps/myfac-verify.yaml", VERIFY_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  propose:
    uses: minifac:myfac-propose
    inputs: { change: foo }
  verify:
    uses: minifac:myfac-verify
    inputs: { change: foo }
    resume: propose
    terminal: true
edges:
  - from: propose
    to: verify
`,
    );
    const { factory } = await loadFactory(fac, repo);
    expect(factory.nodes.verify?.resume).toBe("propose");
    // The step body is byte-identical to what the same step yields for a
    // node that declares no `resume:` — `resume` is a node-level fact the
    // step has no opinion on.
    const facNoResume = await writeAt(
      repo,
      "fac2.yaml",
      `name: f
nodes:
  verify:
    uses: minifac:myfac-verify
    inputs: { change: foo }
    terminal: true
edges: []
`,
    );
    const { factory: plain } = await loadFactory(facNoResume, repo);
    expect(factory.nodes.verify?.with).toEqual(plain.nodes.verify?.with);
    expect(plain.nodes.verify?.resume).toBeUndefined();
  });

  it("preserves `start:` through step inlining", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/myfac-propose.yaml", PROPOSE_STEP);
    await writeAt(repo, "examples/steps/myfac-verify.yaml", VERIFY_STEP);
    const fac = await writeAt(
      repo,
      "fac.yaml",
      `name: f
nodes:
  propose:
    uses: minifac:myfac-propose
    inputs: { change: foo }
    start: true
    max_iterations: 2
  verify:
    uses: minifac:myfac-verify
    inputs: { change: foo }
    terminal: true
edges:
  - from: propose
    to: verify
  - from: verify
    to: propose
    when: on_failure
`,
    );
    const { factory } = await loadFactory(fac, repo);
    expect(factory.nodes.propose?.start).toBe(true);
    expect(factory.nodes.verify?.start).toBeUndefined();
  });
});
