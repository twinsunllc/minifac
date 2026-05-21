import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StepLoadError, loadStep } from "./loader.js";

async function writeStep(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-step-test-"));
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

describe("loadStep", () => {
  it("loads a minimal valid step", async () => {
    const file = await writeStep(
      "ok.yaml",
      `name: foo
version: "1.0.0"
executor: claude
with:
  prompt: "Say hello."
`,
    );
    const { step, sourcePath } = await loadStep(file);
    expect(step.name).toBe("foo");
    expect(step.version).toBe("1.0.0");
    expect(step.executor).toBe("claude");
    expect(step.with).toEqual({ prompt: "Say hello." });
    expect(sourcePath).toBe(file);
  });

  it("rejects missing name", async () => {
    const file = await writeStep(
      "noname.yaml",
      `version: "1.0.0"
executor: claude
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/name/);
  });

  it("rejects missing version", async () => {
    const file = await writeStep(
      "nover.yaml",
      `name: foo
executor: claude
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/version/);
  });

  it("rejects missing executor", async () => {
    const file = await writeStep(
      "noexec.yaml",
      `name: foo
version: "1.0.0"
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/executor/);
  });

  it("rejects missing with", async () => {
    const file = await writeStep(
      "nowith.yaml",
      `name: foo
version: "1.0.0"
executor: claude
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/with/);
  });

  it("rejects unknown top-level key", async () => {
    const file = await writeStep(
      "extra.yaml",
      `name: foo
version: "1.0.0"
executor: claude
with: { prompt: hi }
runtime: node
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/runtime/);
  });

  it("rejects camelCase top-level key", async () => {
    const file = await writeStep(
      "camel.yaml",
      `name: foo
version: "1.0.0"
executor: claude
with: { prompt: hi }
maxIterations: 3
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/maxIterations/);
  });

  it("reports a line number for malformed YAML", async () => {
    const file = await writeStep(
      "broken.yaml",
      `name: foo
version: "1.0.0"
executor: claude
with: { prompt: hi }
extra: { open
`,
    );
    try {
      await loadStep(file);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StepLoadError);
      expect((err as StepLoadError).location?.line).toBeGreaterThan(0);
    }
  });

  it("rejects non-string name", async () => {
    const file = await writeStep(
      "numname.yaml",
      `name: 42
version: "1.0.0"
executor: claude
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/name/);
  });

  it("rejects empty version", async () => {
    const file = await writeStep(
      "emptyver.yaml",
      `name: foo
version: ""
executor: claude
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/version/);
  });

  it("accepts string input definition", async () => {
    const file = await writeStep(
      "in-str.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  change:
    type: string
    required: true
with: { prompt: "{{ inputs.change }}" }
`,
    );
    const { step } = await loadStep(file);
    expect(step.inputs?.change?.type).toBe("string");
    expect(step.inputs?.change?.required).toBe(true);
  });

  it("accepts number input definition with default", async () => {
    const file = await writeStep(
      "in-num.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  count:
    type: number
    default: 3
with: { prompt: hi }
`,
    );
    const { step } = await loadStep(file);
    expect(step.inputs?.count?.type).toBe("number");
    expect(step.inputs?.count?.default).toBe(3);
  });

  it("accepts boolean input definition with default", async () => {
    const file = await writeStep(
      "in-bool.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  dry_run:
    type: boolean
    default: false
with: { prompt: hi }
`,
    );
    const { step } = await loadStep(file);
    expect(step.inputs?.dry_run?.type).toBe("boolean");
    expect(step.inputs?.dry_run?.default).toBe(false);
  });

  it("accepts array input definition with default", async () => {
    const file = await writeStep(
      "in-arr.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  commands:
    type: array
    default: ["npm test"]
with: { prompt: hi }
`,
    );
    const { step } = await loadStep(file);
    expect(step.inputs?.commands?.type).toBe("array");
    expect(step.inputs?.commands?.default).toEqual(["npm test"]);
  });

  it("accepts object input definition", async () => {
    const file = await writeStep(
      "in-obj.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  cfg:
    type: object
with: { prompt: hi }
`,
    );
    const { step } = await loadStep(file);
    expect(step.inputs?.cfg?.type).toBe("object");
  });

  it("rejects unknown type literal", async () => {
    const file = await writeStep(
      "badtype.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  flag:
    type: bool
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/bool/);
  });

  it("rejects missing type on input", async () => {
    const file = await writeStep(
      "notype.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  change:
    required: true
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/type/);
  });

  it("rejects unknown key inside input definition", async () => {
    const file = await writeStep(
      "extrakey.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  change:
    type: string
    validator: "regex:..."
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/validator/);
  });

  it("rejects invalid input name", async () => {
    const file = await writeStep(
      "badname.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  "1st-arg":
    type: string
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/1st-arg|input name/);
  });

  it("rejects required input that declares a default", async () => {
    const file = await writeStep(
      "reqdef.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  change:
    type: string
    required: true
    default: "foo"
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/required|default/);
  });

  it("rejects type-of-default mismatch", async () => {
    const file = await writeStep(
      "deftypemism.yaml",
      `name: foo
version: "1.0.0"
executor: claude
inputs:
  count:
    type: number
    default: "three"
with: { prompt: hi }
`,
    );
    await expect(loadStep(file)).rejects.toThrowError(/type/);
  });
});
