import path from "node:path";
import { describe, expect, it } from "vitest";
import { getInlinedInputs } from "../step/inline.js";
import { loadFactory } from "./loader.js";

const sddPath = path.resolve(__dirname, "..", "..", "examples", "sdd.yaml");
const repoRoot = path.resolve(__dirname, "..", "..");

const norm = (s: string): string =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

/**
 * Deep-equality regression guard for the SDD factory. Whitespace is
 * normalized on prompt strings; the topology, executor selection,
 * permission mode, cwd, inputs map, and edge budgets are checked
 * exactly. Update this snapshot intentionally when a body or topology
 * change is desired.
 */
describe("examples/sdd.yaml resolved snapshot", () => {
  it("matches the canonical resolved shape", async () => {
    const { factory } = await loadFactory(sddPath, repoRoot);

    expect(factory.name).toBe("sdd");
    expect(factory.brief).toBe("required");

    const ids = ["propose", "apply", "verify", "archive"] as const;
    expect(Object.keys(factory.nodes).sort()).toEqual([...ids].sort());

    for (const id of ids) {
      const node = factory.nodes[id];
      expect(node).toBeDefined();
      expect(node?.executor).toBe("claude");
      expect(node?.cwd).toBe("{{ run.cwd }}");
      expect((node?.with as { permission_mode: string }).permission_mode).toBe(
        "bypass_permissions",
      );
      expect(typeof (node?.with as { prompt: unknown }).prompt).toBe("string");
    }

    expect(factory.nodes.archive?.terminal).toBe(true);
    for (const id of ["propose", "apply", "verify"] as const) {
      expect(factory.nodes[id]?.terminal).toBe(false);
    }

    // Inputs maps thread brief data through.
    expect(getInlinedInputs(factory.nodes.propose as object)).toEqual({
      change: "{{ brief.change }}",
      brief_body: "{{ brief.body }}",
    });
    for (const id of ["apply", "archive"] as const) {
      expect(getInlinedInputs(factory.nodes[id] as object)).toEqual({
        change: "{{ brief.change }}",
      });
    }
    // verify's `commands` default is filled in from the step.
    expect(getInlinedInputs(factory.nodes.verify as object)).toEqual({
      change: "{{ brief.change }}",
      commands: ["npm test", "npm run build", "npm run check"],
    });

    // Edges and budgets unchanged from the inline-era topology.
    const edgeKeys = factory.edges
      .map(
        (e) =>
          `${e.from}->${e.to}:${e.when}${e.max_traversals !== undefined ? `@${e.max_traversals}` : ""}`,
      )
      .sort();
    expect(edgeKeys).toEqual(
      [
        "propose->apply:on_success",
        "apply->verify:on_success",
        "verify->archive:on_success",
        "verify->apply:on_failure@3",
      ].sort(),
    );

    // Spot-check prompt body landmarks (whitespace-normalized).
    expect(norm(factory.nodes.propose?.with?.prompt as string)).toContain(
      "Run `openspec new change {{ inputs.change }}`",
    );
    expect(norm(factory.nodes.apply?.with?.prompt as string)).toContain(
      "Read `openspec/changes/{{ inputs.change }}/tasks.md`",
    );
    expect(norm(factory.nodes.verify?.with?.prompt as string)).toContain(
      "openspec validate {{ inputs.change }}",
    );
    expect(norm(factory.nodes.archive?.with?.prompt as string)).toContain(
      "Run `openspec archive {{ inputs.change }} --yes`",
    );
    expect(norm(factory.nodes.archive?.with?.prompt as string)).toContain(
      "Archive: {{ inputs.change }}",
    );
  });
});
