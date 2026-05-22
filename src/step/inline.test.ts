import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FactoryLoadError } from "../factory/loader-error.js";
import { getInlinedInputs, inlineStepIntoNode } from "./inline.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-inline-"));
  return dir;
}

async function writeStep(repo: string, name: string, body: string): Promise<string> {
  const full = path.join(repo, "examples", "steps", `${name}.yaml`);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body, "utf8");
  return full;
}

const FACTORY = "/tmp/fake-factory.yaml";

describe("inlineStepIntoNode", () => {
  it("inlines step body and exposes inputs via getInlinedInputs", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "greet",
      `name: greet
version: "1.0.0"
executor: claude
inputs:
  who:
    type: string
    required: true
with:
  prompt: "Hello {{ inputs.who }}"
`,
    );
    const out = await inlineStepIntoNode({
      factoryPath: FACTORY,
      nodeId: "n1",
      node: { uses: "minifac:greet", inputs: { who: "world" } } as never,
      callerCwd: repo,
    });
    expect(out.executor).toBe("claude");
    expect(out.with).toEqual({ prompt: "Hello world" });
    expect((out as { uses?: unknown }).uses).toBeUndefined();
    expect((out as { inputs?: unknown }).inputs).toBeUndefined();
    expect(getInlinedInputs(out)).toEqual({ who: "world" });
  });

  it("does not enumerate __inputs in Object.keys", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
inputs:
  who:
    type: string
    required: true
with: { prompt: hi }
`,
    );
    const out = await inlineStepIntoNode({
      factoryPath: FACTORY,
      nodeId: "n1",
      node: { uses: "minifac:x", inputs: { who: "w" } } as never,
      callerCwd: repo,
    });
    expect(Object.keys(out)).not.toContain("__inputs");
  });

  it("passes number, boolean, array, object inputs through type check", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "mixed",
      `name: mixed
version: "1"
executor: claude
inputs:
  count: { type: number }
  flag: { type: boolean }
  list: { type: array }
  cfg: { type: object }
with: { prompt: hi }
`,
    );
    const out = await inlineStepIntoNode({
      factoryPath: FACTORY,
      nodeId: "n1",
      node: {
        uses: "minifac:mixed",
        inputs: {
          count: 3,
          flag: true,
          list: ["a", "b"],
          cfg: { k: "v" },
        },
      } as never,
      callerCwd: repo,
    });
    const ins = getInlinedInputs(out);
    expect(ins?.count).toBe(3);
    expect(ins?.flag).toBe(true);
    expect(ins?.list).toEqual(["a", "b"]);
    expect(ins?.cfg).toEqual({ k: "v" });
  });

  it("treats null input value as a type mismatch for non-null-typed inputs", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
inputs:
  cfg: { type: object }
with: { prompt: hi }
`,
    );
    await expect(
      inlineStepIntoNode({
        factoryPath: FACTORY,
        nodeId: "n1",
        node: { uses: "minifac:x", inputs: { cfg: null } } as never,
        callerCwd: repo,
      }),
    ).rejects.toThrowError(/cfg/);
  });

  it("fills in optional input default when node omits it", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
inputs:
  commands: { type: array, default: ["npm test"] }
with: { prompt: hi }
`,
    );
    const out = await inlineStepIntoNode({
      factoryPath: FACTORY,
      nodeId: "n1",
      node: { uses: "minifac:x" } as never,
      callerCwd: repo,
    });
    expect(getInlinedInputs(out)?.commands).toEqual(["npm test"]);
  });

  it("leaves optional input absent when no default and not supplied", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
inputs:
  model: { type: string }
with: { prompt: hi }
`,
    );
    const out = await inlineStepIntoNode({
      factoryPath: FACTORY,
      nodeId: "n1",
      node: { uses: "minifac:x" } as never,
      callerCwd: repo,
    });
    const ins = getInlinedInputs(out);
    expect(ins).toBeDefined();
    expect(Object.hasOwn(ins ?? {}, "model")).toBe(false);
  });

  it("rejects missing required input", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
inputs:
  change: { type: string, required: true }
with: { prompt: hi }
`,
    );
    await expect(
      inlineStepIntoNode({
        factoryPath: FACTORY,
        nodeId: "n1",
        node: { uses: "minifac:x", inputs: {} } as never,
        callerCwd: repo,
      }),
    ).rejects.toThrowError(/change/);
  });

  it("rejects type mismatch", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
inputs:
  commands: { type: array }
with: { prompt: hi }
`,
    );
    await expect(
      inlineStepIntoNode({
        factoryPath: FACTORY,
        nodeId: "n1",
        node: { uses: "minifac:x", inputs: { commands: "npm test" } } as never,
        callerCwd: repo,
      }),
    ).rejects.toThrowError(/commands/);
  });

  it("rejects unknown input key", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
inputs:
  change: { type: string, required: true }
with: { prompt: hi }
`,
    );
    await expect(
      inlineStepIntoNode({
        factoryPath: FACTORY,
        nodeId: "n1",
        node: { uses: "minifac:x", inputs: { change: "c", weather: "sunny" } } as never,
        callerCwd: repo,
      }),
    ).rejects.toThrowError(/weather/);
  });

  it("substitutes inputs at inline time, leaving brief/run tokens for dispatch", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
inputs:
  change: { type: string, required: true }
with:
  prompt: "Change: {{ inputs.change }}"
`,
    );
    const out = await inlineStepIntoNode({
      factoryPath: FACTORY,
      nodeId: "n1",
      node: { uses: "minifac:x", inputs: { change: "{{ brief.change }}" } } as never,
      callerCwd: repo,
    });
    const ins = getInlinedInputs(out);
    expect(ins?.change).toBe("{{ brief.change }}");
    expect((out.with as Record<string, unknown>).prompt).toBe("Change: {{ brief.change }}");
  });

  it("surfaces missing step file as FactoryLoadError", async () => {
    const repo = await makeRepo();
    await expect(
      inlineStepIntoNode({
        factoryPath: FACTORY,
        nodeId: "n1",
        node: { uses: "minifac:nonexistent" } as never,
        callerCwd: repo,
      }),
    ).rejects.toBeInstanceOf(FactoryLoadError);
  });

  it("surfaces malformed reference as FactoryLoadError", async () => {
    const repo = await makeRepo();
    await expect(
      inlineStepIntoNode({
        factoryPath: FACTORY,
        nodeId: "n1",
        node: { uses: "../foo.yaml" } as never,
        callerCwd: repo,
      }),
    ).rejects.toBeInstanceOf(FactoryLoadError);
  });

  it("preserves node-level terminal, max_iterations, cwd", async () => {
    const repo = await makeRepo();
    await writeStep(
      repo,
      "x",
      `name: x
version: "1"
executor: claude
with: { prompt: hi }
`,
    );
    const out = await inlineStepIntoNode({
      factoryPath: FACTORY,
      nodeId: "n1",
      node: {
        uses: "minifac:x",
        terminal: true,
        max_iterations: 5,
        cwd: "{{ run.cwd }}",
      } as never,
      callerCwd: repo,
    });
    expect(out.terminal).toBe(true);
    expect(out.max_iterations).toBe(5);
    expect(out.cwd).toBe("{{ run.cwd }}");
  });
});
