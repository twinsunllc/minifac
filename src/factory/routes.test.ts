import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findUnbudgetedCycles } from "./cycles.js";
import { FactoryLoadError, loadFactory } from "./loader.js";
import { graphEdges, routeEdgeKey, routeEdges, terminalRoutingNodes } from "./routes.js";
import { NodeSchema } from "./schema.js";
import { startNodeIds } from "./start-nodes.js";

// Node-chosen routing (ADR 0055, SCARIFW-2252): the `routes` schema, the
// synthesized `next` output and the load-time rules routes are held to.

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "minifac-routes-"));
}

async function load(yaml: string, extra: Record<string, string> = {}) {
  const dir = await tempDir();
  for (const [rel, contents] of Object.entries(extra)) await writeAt(dir, rel, contents);
  const file = await writeAt(dir, "f.yaml", yaml);
  return loadFactory(file, dir);
}

async function loadErr(yaml: string, extra: Record<string, string> = {}): Promise<string> {
  const err = await load(yaml, extra).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(FactoryLoadError);
  return (err as FactoryLoadError).message;
}

/** implement → checks_gate → review → evaluate, evaluate routing back. */
function loop(evaluate: string, extraNodes = ""): string {
  return `name: loop
nodes:
  implement:
    executor: claude
    start: true
  checks_gate:
    executor: claude
  review:
    executor: claude
  evaluate:
    executor: claude
${evaluate}
  verify:
    executor: claude
    terminal: true
${extraNodes}edges:
  - { from: implement, to: checks_gate }
  - { from: checks_gate, to: review }
  - { from: review, to: evaluate }
  - { from: evaluate, to: verify }
`;
}

describe("routes schema", () => {
  const parse = (routes: unknown) => NodeSchema.safeParse({ executor: "claude", routes });

  it("accepts bare node ids and { to, max_traversals } entries", () => {
    const r = parse(["implement", { to: "checks_gate", max_traversals: 2 }, { to: "x" }]);
    expect(r.success).toBe(true);
  });

  it.each([
    ["a duplicate target", ["a", { to: "a", max_traversals: 1 }], 'duplicate route "a"'],
    ["an unknown key", [{ to: "a", when: "on_success" }], 'Unrecognized key: "when"'],
    ["a zero budget", [{ to: "a", max_traversals: 0 }], "Too small: expected number to be >0"],
    [
      "a non-integer budget",
      [{ to: "a", max_traversals: 1.5 }],
      "invalid route at max_traversals: Invalid input: expected int",
    ],
    ["an empty id", [""], "a route must name a node"],
    ["a number", [3], "a route must be a node id or { to: <id>, max_traversals: <n> }"],
    ["an empty list", [], "routes must list at least one node"],
  ])("refuses %s", (_label, routes, message) => {
    const r = parse(routes);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join(" | ")).toContain(message);
  });

  it("a { to } entry without a budget is the same as the bare id", async () => {
    const { factory } = await load(
      loop("    max_iterations: 3\n    routes: [{ to: implement }, checks_gate]"),
    );
    expect(routeEdges(factory)).toEqual([
      { from: "evaluate", to: "implement", when: "route" },
      { from: "evaluate", to: "checks_gate", when: "route" },
    ]);
  });

  it("a step file may not declare routes (workflow only)", async () => {
    const msg = await loadErr(
      `name: f
nodes:
  evaluate:
    uses: minifac:evaluate
  verify:
    executor: claude
    terminal: true
edges:
  - { from: evaluate, to: verify }
`,
      {
        "examples/steps/evaluate.yaml": `name: evaluate
version: "1"
executor: claude
routes: [verify]
with:
  prompt: hi
`,
      },
    );
    expect(msg).toContain('Unrecognized key: "routes"');
  });
});

describe("synthesized next output", () => {
  it("is a non-required value output with enum [<routes>..., null]", async () => {
    const { factory } = await load(
      loop(
        "    routes: [implement, { to: checks_gate, max_traversals: 2 }]\n    max_iterations: 3",
      ),
    );
    expect(factory.nodes.evaluate?.routes).toEqual([
      "implement",
      { to: "checks_gate", max_traversals: 2 },
    ]);
    expect(factory.nodes.evaluate?.outputs?.next).toMatchObject({
      type: "value",
      required: false,
      schema: { enum: ["implement", "checks_gate", null] },
    });
  });

  it("is added beside the node's own outputs", async () => {
    const { factory } = await load(
      loop(
        "    max_iterations: 3\n    routes: [implement]\n    outputs: { result: { type: value } }",
      ),
    );
    expect(Object.keys(factory.nodes.evaluate?.outputs ?? {})).toEqual(["result", "next"]);
  });

  it("a routing node that declares its own next output is a load error", async () => {
    const msg = await loadErr(
      loop(
        "    max_iterations: 3\n    routes: [implement]\n    outputs: { next: { type: value } }",
      ),
    );
    expect(msg).toContain('Node "evaluate" declares `routes:` and also has an output "next"');
  });

  it("a routing uses: node whose step declares next is a load error", async () => {
    const msg = await loadErr(
      loop("    max_iterations: 3\n    routes: [implement]").replace(
        "  evaluate:\n    executor: claude\n",
        "  evaluate:\n    uses: minifac:evaluate\n",
      ),
      {
        "examples/steps/evaluate.yaml": `name: evaluate
version: "1"
executor: claude
with:
  prompt: hi
outputs:
  next: { type: value }
`,
      },
    );
    expect(msg).toContain('Node "evaluate" declares `routes:` and also has an output "next"');
  });

  it("a routing uses: node keeps its routes through inlining and gets next", async () => {
    const { factory } = await load(
      loop("    max_iterations: 3\n    routes: [implement]").replace(
        "  evaluate:\n    executor: claude\n",
        "  evaluate:\n    uses: minifac:evaluate\n",
      ),
      {
        "examples/steps/evaluate.yaml": `name: evaluate
version: "1"
executor: claude
with:
  prompt: hi
outputs:
  result: { type: value }
`,
      },
    );
    expect(factory.nodes.evaluate?.routes).toEqual(["implement"]);
    expect(Object.keys(factory.nodes.evaluate?.outputs ?? {})).toEqual(["result", "next"]);
  });

  it("a node without routes may declare next, and gets nothing synthesized", async () => {
    const { factory } = await load(
      loop("    outputs: { next: { type: value, schema: { type: string } } }"),
    );
    expect(factory.nodes.evaluate?.outputs?.next).toEqual({
      type: "value",
      required: false,
      schema: { type: "string" },
    });
    for (const [id, node] of Object.entries(factory.nodes)) {
      if (id !== "evaluate") expect(node.outputs, id).toBeUndefined();
    }
  });

  it("a value edge may test the synthesized next", async () => {
    const msg = await loadErr(
      `${loop("    max_iterations: 3\n    routes: [implement]")}  - { from: evaluate, to: checks_gate, when: { output: next, equals: verify } }
`,
    );
    // The synthesized schema's enum is what the value edge is checked against.
    expect(msg).toContain(
      'tests path "next" for "verify", which its schema\'s enum/const never allows',
    );
  });
});

describe("route load errors", () => {
  it("a route to an undeclared node names the node and the entry", async () => {
    const msg = await loadErr(loop("    max_iterations: 3\n    routes: [implement, nowhere]"));
    expect(msg).toContain(
      'Node "evaluate" routes entry "nowhere" (routes[1]) names no declared node',
    );
  });

  it("a route whose target cannot reach a terminal node is a load error", async () => {
    const msg = await loadErr(
      loop("    routes: [dead_end]", "  dead_end:\n    executor: claude\n"),
    );
    expect(msg).toContain(
      'Node "evaluate" routes entry "dead_end" (routes[0]) cannot reach a terminal node',
    );
  });

  it("a target that reaches a terminal only through another route loads", async () => {
    const { factory } = await load(
      loop("    routes: [triage]", "  triage:\n    executor: claude\n    routes: [verify]\n"),
    );
    expect(factory.nodes.triage?.outputs?.next).toBeDefined();
  });

  it("a target that reaches a terminal only through an on_failure edge loads", async () => {
    const yaml = `${loop("    routes: [triage]", "  triage:\n    executor: claude\n")}  - { from: triage, to: verify, when: on_failure }
`;
    await expect(load(yaml)).resolves.toBeDefined();
  });

  it("a terminal target loads", async () => {
    await expect(load(loop("    routes: [verify]"))).resolves.toBeDefined();
  });
});

describe("routes are edges for start nodes and cycle budgets", () => {
  it("a route target is not a start node", async () => {
    const { factory } = await load(
      loop("    routes: [audit]", "  audit:\n    executor: claude\n    terminal: true\n"),
    );
    expect(startNodeIds(factory)).toEqual(["implement"]);
  });

  it("a cycle closed only by an unbudgeted route is a load error", async () => {
    const msg = await loadErr(loop("    routes: [implement]"));
    expect(msg).toContain("Cycle is not covered by any budget");
    expect(msg).toContain("evaluate");
  });

  it("a route's max_traversals covers the cycle it closes", async () => {
    const { warnings } = await load(loop("    routes: [{ to: implement, max_traversals: 2 }]"));
    expect(warnings).toEqual([]);
  });

  it("a node's max_iterations covers a route cycle", async () => {
    const { warnings } = await load(loop("    max_iterations: 3\n    routes: [implement]"));
    expect(warnings).toEqual([]);
  });

  it("an uncovered route cycle in a budgeted component is an uncovered_cycle warning naming the route", async () => {
    const { factory, warnings } = await load(
      loop("    routes: [{ to: implement, max_traversals: 2 }, checks_gate]"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toMatchObject({
      code: "uncovered_cycle",
      nodes: ["checks_gate", "review", "evaluate"],
      edge: { from: "evaluate", to: "checks_gate", when: "route" },
    });
    expect(warnings?.[0]?.message).toContain(
      'add `max_traversals` to node "evaluate"\'s route to "checks_gate" (`{ to: checks_gate, max_traversals: <n> }`)',
    );
    expect(findUnbudgetedCycles(factory)).toHaveLength(1);
  });

  it("the route's traversal key is <from>-><to>:route", () => {
    expect(routeEdgeKey("evaluate", "implement")).toBe("evaluate->implement:route");
  });

  it("a factory without routes has exactly its declared edges as graph edges", async () => {
    const { factory } = await load(loop(""));
    expect(graphEdges(factory)).toBe(factory.edges);
    expect(routeEdges(factory)).toEqual([]);
  });
});

describe("a terminal node that declares routes", () => {
  // evaluate is terminal and may route back to implement on a judged failure.
  const terminalRouting = loop(
    "    terminal: true\n    routes: [{ to: implement, max_traversals: 2 }]",
  );

  it("loads with one terminal_routes warning naming the node and the file", async () => {
    const { sourcePath, warnings } = await load(terminalRouting);
    expect(warnings).toEqual([
      {
        code: "terminal_routes",
        sourcePath,
        node: "evaluate",
        message:
          'Node "evaluate" is terminal and declares `routes:`: its success ends the run, so its routes are taken only on a judged failure.',
      },
    ]);
  });

  it("still loads under strictBudgets, with the warning", async () => {
    const dir = await tempDir();
    const file = await writeAt(dir, "f.yaml", terminalRouting);
    const { warnings } = await loadFactory(file, dir, { strictBudgets: true });
    expect(warnings?.map((w) => w.code)).toEqual(["terminal_routes"]);
  });

  it("a non-terminal routing node gets no such warning", async () => {
    const { factory, warnings } = await load(
      loop("    routes: [{ to: implement, max_traversals: 2 }]"),
    );
    expect(warnings).toEqual([]);
    expect(terminalRoutingNodes(factory)).toEqual([]);
  });

  it("a terminal node without routes gets no such warning", async () => {
    const { factory } = await load(loop(""));
    expect(terminalRoutingNodes(factory)).toEqual([]);
  });
});

describe("extends: a layer that redeclares a routing node replaces its routes", () => {
  it("drops the routes and the synthesized next when the layer omits routes", async () => {
    const base = loop("    max_iterations: 3\n    routes: [implement]");
    const dir = await tempDir();
    await writeAt(dir, ".minifac/factories/base.yaml", base);
    const file = await writeAt(
      dir,
      "derived.yaml",
      `extends: base
name: derived
nodes:
  evaluate:
    executor: claude
`,
    );
    const { factory } = await loadFactory(file, dir);
    expect(factory.nodes.evaluate?.routes).toBeUndefined();
    expect(factory.nodes.evaluate?.outputs).toBeUndefined();
    expect(routeEdges(factory)).toEqual([]);
  });

  it("keeps them when the layer leaves the node alone", async () => {
    const base = loop("    max_iterations: 3\n    routes: [implement]");
    const dir = await tempDir();
    await writeAt(dir, ".minifac/factories/base.yaml", base);
    const file = await writeAt(dir, "derived.yaml", "extends: base\nname: derived\n");
    const { factory } = await loadFactory(file, dir);
    expect(factory.nodes.evaluate?.routes).toEqual(["implement"]);
    expect(factory.nodes.evaluate?.outputs?.next).toBeDefined();
  });
});

describe("examples/routing.yaml", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const file = path.join(repoRoot, "examples", "routing.yaml");

  it("loads, with evaluate routing to implement or checks_gate", async () => {
    const { factory, warnings } = await loadFactory(file, repoRoot);
    expect(warnings).toEqual([]);
    expect(factory.nodes.evaluate?.routes).toEqual(["implement", "checks_gate"]);
    expect(factory.nodes.evaluate?.outputs?.next).toMatchObject({
      schema: { enum: ["implement", "checks_gate", null] },
    });
    expect(startNodeIds(factory)).toEqual(["implement"]);
  });
});
