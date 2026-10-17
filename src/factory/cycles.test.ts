import { describe, expect, it } from "vitest";
import { findUnbudgetedCycles, findUncoveredCycles } from "./cycles.js";
import type { Factory, FactoryEdge } from "./schema.js";

const node = (extra: Partial<Factory["nodes"][string]> = {}) => ({
  executor: "claude",
  terminal: false,
  ...extra,
});

const edge = (
  from: string,
  to: string,
  extra: Partial<Pick<FactoryEdge, "when" | "max_traversals">> = {},
): FactoryEdge => ({ from, to, when: "on_success", ...extra });

/**
 * scarif-factory FINDINGS F9: an inner implement ⇄ review loop with no
 * budget, inside an outer loop capped on verify → implement. The per-SCC
 * check passes it, because the SCC carries a budget on another edge.
 */
function f9(
  overrides: {
    innerCap?: number;
    implementMaxIterations?: number;
  } = {},
): Factory {
  return {
    name: "f9",
    nodes: {
      plan: node(),
      implement: node(
        overrides.implementMaxIterations !== undefined
          ? { max_iterations: overrides.implementMaxIterations }
          : {},
      ),
      review: node(),
      verify: node(),
      done: node({ terminal: true }),
    },
    edges: [
      edge("plan", "implement"),
      edge("implement", "review"),
      edge(
        "review",
        "implement",
        overrides.innerCap !== undefined
          ? { when: "on_failure", max_traversals: overrides.innerCap }
          : { when: "on_failure" },
      ),
      edge("review", "verify"),
      edge("verify", "implement", { when: "on_failure", max_traversals: 3 }),
      edge("verify", "done"),
    ],
  };
}

describe("findUnbudgetedCycles", () => {
  it("F9: names the uncapped inner loop and the edge review → implement", () => {
    const f = f9();
    // The existing per-SCC check accepts this graph: that is the gap.
    expect(findUncoveredCycles(f)).toEqual([]);
    expect(findUnbudgetedCycles(f)).toEqual([
      {
        nodes: ["implement", "review"],
        edge: { from: "review", to: "implement", when: "on_failure" },
      },
    ]);
  });

  it("a fully capped nested graph has no unbudgeted cycle", () => {
    expect(findUnbudgetedCycles(f9({ innerCap: 2 }))).toEqual([]);
  });

  it("max_iterations on a node covers every cycle through it", () => {
    expect(findUnbudgetedCycles(f9({ implementMaxIterations: 5 }))).toEqual([]);
  });

  it("max_iterations on a node outside the inner loop does not cover it", () => {
    const f = f9();
    f.nodes.verify = node({ max_iterations: 5 });
    expect(findUnbudgetedCycles(f).map((c) => c.edge)).toEqual([
      { from: "review", to: "implement", when: "on_failure" },
    ]);
  });

  it("reports an unbudgeted self-loop inside a budgeted component", () => {
    const f = f9({ innerCap: 2 });
    f.edges.push(edge("review", "review", { when: "on_failure" }));
    expect(findUnbudgetedCycles(f)).toEqual([
      { nodes: ["review"], edge: { from: "review", to: "review", when: "on_failure" } },
    ]);
  });

  it("reports each of two independent uncapped inner loops; capping both silences it", () => {
    const f: Factory = {
      name: "two-loops",
      nodes: {
        a: node(),
        b: node(),
        c: node(),
        d: node(),
        done: node({ terminal: true }),
      },
      edges: [
        edge("a", "b"),
        edge("b", "a", { when: "on_failure" }),
        edge("b", "c"),
        edge("c", "d"),
        edge("d", "c", { when: "on_failure" }),
        edge("d", "a", { when: "on_failure", max_traversals: 2 }),
        edge("d", "done"),
      ],
    };
    const found = findUnbudgetedCycles(f);
    expect(found).toEqual([
      { nodes: ["a", "b"], edge: { from: "b", to: "a", when: "on_failure" } },
      { nodes: ["c", "d"], edge: { from: "d", to: "c", when: "on_failure" } },
    ]);

    for (const { edge: named } of found) {
      const e = f.edges.find(
        (x) => x.from === named.from && x.to === named.to && x.when === named.when,
      );
      if (e) e.max_traversals = 1;
    }
    expect(findUnbudgetedCycles(f)).toEqual([]);
  });

  it("names every edge of overlapping cycles, so capping the list is enough", () => {
    // Two cycles share the edge a → b: a → b → c → a and a → b → a.
    const f: Factory = {
      name: "overlap",
      nodes: { s: node(), a: node(), b: node(), c: node(), done: node({ terminal: true }) },
      edges: [
        edge("s", "a"),
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "a", { when: "on_failure" }),
        edge("b", "a", { when: "on_failure" }),
        edge("a", "done", { when: "on_failure", max_traversals: 1 }),
        edge("c", "s", { when: "on_failure", max_traversals: 1 }),
        edge("c", "done"),
      ],
    };
    const found = findUnbudgetedCycles(f);
    expect(found.length).toBeGreaterThan(0);
    for (const { edge: named } of found) {
      const e = f.edges.find(
        (x) => x.from === named.from && x.to === named.to && x.when === named.when,
      );
      if (e) e.max_traversals = 1;
    }
    expect(findUnbudgetedCycles(f)).toEqual([]);
  });

  it("an on_error edge's max_traversals covers its cycle", () => {
    const f = f9();
    f.edges.push(edge("implement", "plan", { when: "on_error", max_traversals: 1 }));
    f.edges[2] = edge("review", "implement", { when: "on_error", max_traversals: 1 });
    expect(findUnbudgetedCycles(f)).toEqual([]);
  });

  it("parallel edges are distinct: capping on_failure leaves an uncapped on_success twin", () => {
    const f = f9({ innerCap: 2 });
    f.edges.push(edge("review", "implement", { when: "on_success" }));
    expect(findUnbudgetedCycles(f)).toEqual([
      {
        nodes: ["implement", "review"],
        edge: { from: "review", to: "implement", when: "on_success" },
      },
    ]);
  });

  it("leaves a component with no budget at all to findUncoveredCycles", () => {
    const f: Factory = {
      name: "bare",
      nodes: { s: node(), a: node(), b: node(), done: node({ terminal: true }) },
      edges: [
        edge("s", "a"),
        edge("a", "b"),
        edge("b", "a", { when: "on_failure" }),
        edge("b", "done"),
      ],
    };
    expect(findUncoveredCycles(f)).toHaveLength(1);
    expect(findUnbudgetedCycles(f)).toEqual([]);
  });

  it("is deterministic across calls", () => {
    const f = f9();
    expect(findUnbudgetedCycles(f)).toEqual(findUnbudgetedCycles(f));
  });
});
