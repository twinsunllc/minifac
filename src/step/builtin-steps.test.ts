import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadStep } from "./loader.js";
import { resolveStepRef } from "./resolve.js";

const repoRoot = path.resolve(__dirname, "..", "..");

const BUNDLED = [
  "openspec-propose",
  "openspec-apply",
  "openspec-verify",
  "openspec-archive",
  "check-merge",
] as const;

describe("bundled built-in steps", () => {
  for (const name of BUNDLED) {
    it(`loads examples/steps/${name}.yaml cleanly`, async () => {
      const stepPath = path.join(repoRoot, "examples", "steps", `${name}.yaml`);
      const loaded = await loadStep(stepPath);
      expect(loaded.step.name).toBe(name);
      expect(typeof loaded.step.version).toBe("string");
      expect(loaded.step.version.length).toBeGreaterThan(0);
      expect(typeof loaded.step.executor).toBe("string");
      expect(loaded.step.with).toBeDefined();
    });

    it(`resolves minifac:${name} to examples/steps/${name}.yaml`, async () => {
      const resolved = await resolveStepRef(`minifac:${name}`, repoRoot);
      expect(resolved).toBe(path.join(repoRoot, "examples", "steps", `${name}.yaml`));
    });
  }

  it("check-merge step has the expected input shape", async () => {
    const stepPath = path.join(repoRoot, "examples", "steps", "check-merge.yaml");
    const { step } = await loadStep(stepPath);
    expect(step.executor).toBe("check-merge");
    expect(step.inputs?.base?.type).toBe("string");
    expect(step.inputs?.base?.required).not.toBe(true);
    expect(step.inputs?.base?.default).toBe("{{ run.base_branch }}");
    expect(step.inputs?.mode?.type).toBe("string");
    expect(step.inputs?.mode?.required).not.toBe(true);
    expect(step.inputs?.mode?.default).toBe("any-merge");
    expect(step.with).toEqual({
      base: "{{ inputs.base }}",
      mode: "{{ inputs.mode }}",
    });
  });
});
