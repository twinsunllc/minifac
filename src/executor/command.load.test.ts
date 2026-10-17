import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactoryLoadError, loadFactory } from "../factory/loader.js";
import { StepLoadError, loadStep } from "../step/loader.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "minifac-command-load-"));
  await mkdir(path.join(repo, "examples", "steps"), { recursive: true });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeAt(rel: string, contents: string): Promise<string> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

function inlineFactory(withYaml: string): string {
  return `name: f
nodes:
  gate:
    executor: command
    terminal: true
    with:
${withYaml
  .split("\n")
  .map((l) => `      ${l}`)
  .join("\n")}
edges: []
`;
}

function commandStep(withYaml: string): string {
  return `name: gate-step
version: "1.0.0"
executor: command
with:
${withYaml
  .split("\n")
  .map((l) => `  ${l}`)
  .join("\n")}
`;
}

const BAD_CASES: Array<[string, string, string]> = [
  ["an empty commands list", "commands: []", "with.commands: "],
  [
    "a duplicate command id",
    "commands:\n  - { id: a, run: 'true' }\n  - { id: a, run: 'true' }",
    "with.commands[1].id: duplicate command id `a`",
  ],
  [
    "a result_from naming no command",
    "result_from: nope\ncommands:\n  - { id: a, run: 'true' }",
    "with.result_from: `result_from` names no declared command (`nope`)",
  ],
  [
    "result_from and result_file together",
    "result_from: a\nresult_file: r.json\ncommands:\n  - { id: a, run: 'true' }",
    "with.result_from: `result_from` and `result_file` are mutually exclusive",
  ],
  [
    "an unknown command key",
    "commands:\n  - { id: a, run: 'true', shell: bash }",
    "with.commands[0].shell: unknown key `shell`",
  ],
  ["a command without run", "commands:\n  - { id: a }", "with.commands[0].run: "],
  [
    "an unknown with key",
    "commands:\n  - { id: a, run: 'true' }\nprompt: hi",
    "with.prompt: unknown key `prompt`",
  ],
];

describe("load-time validation of executor: command", () => {
  describe("inline node", () => {
    it.each(BAD_CASES)("rejects %s, naming the file and key", async (_label, yaml, key) => {
      const fac = await writeAt("fac.yaml", inlineFactory(yaml));
      const err = await loadFactory(fac, repo).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FactoryLoadError);
      expect((err as FactoryLoadError).sourcePath).toBe(fac);
      expect((err as FactoryLoadError).message).toContain(`Node "gate" ${key}`);
    });

    it("loads a valid command node without applying defaults into it", async () => {
      const fac = await writeAt(
        "fac.yaml",
        inlineFactory("commands:\n  - { id: a, run: 'echo {{ run.outputs_dir }}' }"),
      );
      const { factory } = await loadFactory(fac, repo);
      expect(factory.nodes.gate?.with).toEqual({
        commands: [{ id: "a", run: "echo {{ run.outputs_dir }}" }],
      });
    });
  });

  describe("step", () => {
    it.each(BAD_CASES)("loadStep rejects %s, naming the file and key", async (_l, yaml, key) => {
      const stepPath = await writeAt("examples/steps/gate-step.yaml", commandStep(yaml));
      const err = await loadStep(stepPath).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StepLoadError);
      expect((err as StepLoadError).sourcePath).toBe(stepPath);
      expect((err as StepLoadError).message).toContain(`Schema error at ${key}`);
    });

    it("a uses: node of a bad step fails the factory load, naming the step file and key", async () => {
      const stepPath = await writeAt(
        "examples/steps/gate-step.yaml",
        commandStep("commands:\n  - { id: a, run: 'true' }\n  - { id: a, run: 'true' }"),
      );
      const fac = await writeAt(
        "fac.yaml",
        "name: f\nnodes:\n  gate:\n    uses: minifac:gate-step\n    terminal: true\nedges: []\n",
      );
      const err = await loadFactory(fac, repo).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FactoryLoadError);
      expect((err as FactoryLoadError).message).toContain(stepPath);
      expect((err as FactoryLoadError).message).toContain("with.commands[1].id");
    });

    it("a valid step inlines; uses-node with.secrets is accepted", async () => {
      await writeAt(
        "examples/steps/gate-step.yaml",
        `name: gate-step
version: "1.0.0"
executor: command
inputs:
  title: { type: string, required: true }
with:
  result_file: "{{ inputs.title }}.json"
  commands:
    - { id: a, run: "printf '%s' {{ inputs.title }}" }
`,
      );
      const fac = await writeAt(
        "fac.yaml",
        `name: f
nodes:
  gate:
    uses: minifac:gate-step
    inputs: { title: "x" }
    with: { secrets: [TOKEN] }
    terminal: true
edges: []
`,
      );
      const { factory } = await loadFactory(fac, repo);
      // `commands` is a list, so its `{{ inputs.* }}` tokens are left for the
      // runner's shell-safe substitution at dispatch, never spliced at load.
      expect(factory.nodes.gate?.with).toEqual({
        result_file: "x.json",
        commands: [{ id: "a", run: "printf '%s' {{ inputs.title }}" }],
        secrets: ["TOKEN"],
      });
    });
  });

  it("claude and check-merge nodes are not validated against the command schema", async () => {
    const fac = await writeAt(
      "fac.yaml",
      `name: f
nodes:
  a:
    executor: claude
    with: { prompt: hi, commands: [] }
  b:
    executor: check-merge
    terminal: true
    with: { base: main }
edges:
  - { from: a, to: b }
`,
    );
    const { factory } = await loadFactory(fac, repo);
    expect(factory.nodes.a?.with).toEqual({ prompt: "hi", commands: [] });
  });

  it("every shipped example factory still loads", async () => {
    const examples = path.resolve(__dirname, "..", "..", "examples");
    const files = (await readdir(examples)).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      await expect(
        loadFactory(path.join(examples, f), path.resolve(examples, "..")),
      ).resolves.toBeDefined();
    }
  });
});
