import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FactoryLoadError, formatFactoryLoadWarning, loadFactory } from "./loader.js";

// ADR 0053: loop budgets per elementary cycle, shipped warn-first.

async function writeFactory(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-budget-"));
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

/** scarif-factory FINDINGS F9: inner review → implement uncapped, outer verify → implement capped. */
function f9Yaml(innerEdgeExtra = "", implementExtra = ""): string {
  return `name: f9
nodes:
  plan:
    executor: claude
  implement:
    executor: claude${implementExtra}
  review:
    executor: claude
  verify:
    executor: claude
  done:
    executor: claude
    terminal: true
edges:
  - { from: plan, to: implement }
  - { from: implement, to: review }
  - { from: review, to: implement, when: on_failure${innerEdgeExtra} }
  - { from: review, to: verify }
  - { from: verify, to: implement, when: on_failure, max_traversals: 3 }
  - { from: verify, to: done }
`;
}

describe("loop budgets per cycle (ADR 0053)", () => {
  it("F9 loads by default with one structured uncovered_cycle warning", async () => {
    const file = await writeFactory("f9.yaml", f9Yaml());
    const loaded = await loadFactory(file);
    expect(loaded.warnings).toHaveLength(1);
    const w = loaded.warnings?.[0];
    expect(w).toMatchObject({
      code: "uncovered_cycle",
      sourcePath: file,
      nodes: ["implement", "review"],
      edge: { from: "review", to: "implement", when: "on_failure" },
    });
    expect(path.isAbsolute(w?.sourcePath ?? "")).toBe(true);
    expect(w?.message).toContain("implement → review → implement");
    expect(w?.message).toContain("on_failure edge review → implement");
    expect(w && formatFactoryLoadWarning(w)).toBe(`warning: ${file}: ${w?.message}`);
  });

  it("F9 is refused under strictBudgets, naming the cycle and the edge to cap", async () => {
    const file = await writeFactory("f9.yaml", f9Yaml());
    const err = await loadFactory(file, process.cwd(), { strictBudgets: true }).catch((e) => e);
    expect(err).toBeInstanceOf(FactoryLoadError);
    expect(err.message).toMatch(/implement → review → implement/);
    expect(err.message).toMatch(/edge review → implement/);
    expect(err.sourcePath).toBe(file);
  });

  it("strictBudgets: false behaves as the default", async () => {
    const file = await writeFactory("f9.yaml", f9Yaml());
    const loaded = await loadFactory(file, process.cwd(), { strictBudgets: false });
    expect(loaded.warnings).toHaveLength(1);
  });

  for (const [label, yaml] of [
    ["max_traversals on review → implement", f9Yaml(", max_traversals: 2")],
    ["max_iterations on implement", f9Yaml("", "\n    max_iterations: 4")],
  ] as const) {
    it(`a fully capped nested graph (${label}) is silent in both modes`, async () => {
      const file = await writeFactory("capped.yaml", yaml);
      expect((await loadFactory(file)).warnings).toEqual([]);
      const strict = await loadFactory(file, process.cwd(), { strictBudgets: true });
      expect(strict.warnings).toEqual([]);
    });
  }

  it("a component with no budget anywhere is still a load error by default", async () => {
    const file = await writeFactory(
      "bare.yaml",
      `name: bare
nodes:
  a:
    executor: claude
    start: true
  b:
    executor: claude
  done:
    executor: claude
    terminal: true
edges:
  - { from: a, to: b }
  - { from: b, to: a, when: on_failure }
  - { from: b, to: done }
`,
    );
    await expect(loadFactory(file)).rejects.toThrow(/Cycle is not covered by any budget/);
  });

  it("two uncapped inner loops give two warnings; capping each named edge silences them", async () => {
    const body = (capBA: string, capDC: string) => `name: two
nodes:
  s:
    executor: claude
  a:
    executor: claude
  b:
    executor: claude
  c:
    executor: claude
  d:
    executor: claude
  done:
    executor: claude
    terminal: true
edges:
  - { from: s, to: a }
  - { from: a, to: b }
  - { from: b, to: a, when: on_failure${capBA} }
  - { from: b, to: c }
  - { from: c, to: d }
  - { from: d, to: c, when: on_failure${capDC} }
  - { from: d, to: a, when: on_failure, max_traversals: 2 }
  - { from: d, to: done }
`;
    const file = await writeFactory("two.yaml", body("", ""));
    const loaded = await loadFactory(file);
    expect(loaded.warnings?.map((w) => w.edge)).toEqual([
      { from: "b", to: "a", when: "on_failure" },
      { from: "d", to: "c", when: "on_failure" },
    ]);
    const capped = await writeFactory(
      "two.yaml",
      body(", max_traversals: 1", ", max_traversals: 1"),
    );
    expect((await loadFactory(capped, process.cwd(), { strictBudgets: true })).warnings).toEqual(
      [],
    );
  });

  it("every workflow under examples/ loads under strictBudgets with no warning", async () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const dir = path.join(repoRoot, "examples");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const loaded = await loadFactory(path.join(dir, f), repoRoot, { strictBudgets: true });
      expect(loaded.warnings, f).toEqual([]);
    }
  });
});
