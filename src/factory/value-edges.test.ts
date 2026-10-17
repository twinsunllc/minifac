import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FactoryLoadError, loadFactory } from "./loader.js";
import { EdgeSchema } from "./schema.js";
import { conditionMatches, edgeWhenKey, resolveOutputPath } from "./value-edges.js";

// Value-conditioned edges (ADR 0055): the `when` schema, the canonical edge
// key, run-time matching and the load-time checks.

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "minifac-value-edges-"));
}

const DECISION_SCHEMA =
  "{ type: object, required: [decision], additionalProperties: false, properties: { decision: { enum: [approve, revise, escalate] }, notes: { type: string } } }";

/** evaluate → verify | implement | escalate on result.decision. */
function threeWay(opts: { outputs?: string; edges?: string } = {}): string {
  const outputs =
    opts.outputs ?? `{ result: { type: value, required: true, schema: ${DECISION_SCHEMA} } }`;
  const edges =
    opts.edges ??
    `  - { from: evaluate, to: verify, when: { output: result.decision, equals: approve } }
  - { from: evaluate, to: implement, max_traversals: 2, when: { output: result.decision, equals: revise } }
  - { from: evaluate, to: escalate, when: { output: result.decision, in: [escalate] } }
`;
  return `name: three-way
nodes:
  implement:
    executor: claude
    start: true
  evaluate:
    executor: claude
    outputs: ${outputs}
  verify:
    executor: claude
    terminal: true
  escalate:
    executor: claude
    terminal: true
edges:
  - { from: implement, to: evaluate }
${edges}`;
}

async function loadErr(yaml: string): Promise<FactoryLoadError> {
  const dir = await tempDir();
  const file = await writeAt(dir, "f.yaml", yaml);
  const err = await loadFactory(file, dir).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(FactoryLoadError);
  return err as FactoryLoadError;
}

describe("value condition schema", () => {
  const parse = (when: unknown) => EdgeSchema.safeParse({ from: "a", to: "b", when });
  const firstMessage = (when: unknown): string => {
    const r = parse(when);
    expect(r.success).toBe(false);
    return r.success ? "" : (r.error.issues[0]?.message ?? "");
  };

  it("accepts equals and in, and keeps the literal forms", () => {
    expect(parse({ output: "result.decision", equals: "revise" }).data?.when).toEqual({
      output: "result.decision",
      equals: "revise",
    });
    expect(parse({ output: "result", in: [1, true, null, "x"] }).success).toBe(true);
    expect(parse("on_error").data?.when).toBe("on_error");
    expect(EdgeSchema.parse({ from: "a", to: "b" }).when).toBe("on_success");
  });

  it("rejects both operators and neither", () => {
    expect(firstMessage({ output: "result.decision", equals: "a", in: ["b"] })).toMatch(
      /exactly one of `equals` and `in`/,
    );
    expect(firstMessage({ output: "result.decision" })).toMatch(/exactly one of/);
  });

  it("rejects a non-scalar equals, an empty in and a malformed path", () => {
    expect(firstMessage({ output: "result", equals: { a: 1 } })).toMatch(/JSON scalar/);
    expect(firstMessage({ output: "result", equals: ["a"] })).toMatch(/JSON scalar/);
    expect(firstMessage({ output: "result", in: [] })).toMatch(/at least one value/);
    expect(firstMessage({ output: "result..decision", equals: "a" })).toMatch(/dotted property/);
    expect(firstMessage({ output: "1result", equals: "a" })).toMatch(/dotted property/);
    expect(firstMessage({ output: "result", equals: "a", or: "b" })).toMatch(/Unrecognized/);
  });

  it("still rejects an unknown literal, listing the supported values", () => {
    const msg = firstMessage("on_weekend");
    for (const lit of ["on_success", "on_failure", "on_error"]) expect(msg).toContain(lit);
    expect(msg).toContain("value condition");
  });
});

describe("edgeWhenKey", () => {
  it("is the literal for outcome edges", () => {
    expect(edgeWhenKey({ when: "on_failure" })).toBe("on_failure");
  });

  it("encodes the path and JSON value, distinct per value and operator", () => {
    expect(edgeWhenKey({ when: { output: "result.decision", equals: "revise" } })).toBe(
      'output:result.decision="revise"',
    );
    expect(edgeWhenKey({ when: { output: "result.decision", in: ["revise", "x"] } })).toBe(
      'output:result.decision in ["revise","x"]',
    );
    expect(edgeWhenKey({ when: { output: "result.n", equals: 1 } })).not.toBe(
      edgeWhenKey({ when: { output: "result.n", equals: "1" } }),
    );
  });
});

describe("conditionMatches", () => {
  it("walks plain objects and compares strictly", () => {
    const value = { decision: "revise", n: 1, nested: { ok: true }, list: ["a"] };
    expect(conditionMatches({ output: "result.decision", equals: "revise" }, value)).toBe(true);
    expect(conditionMatches({ output: "result.decision", in: ["approve"] }, value)).toBe(false);
    expect(conditionMatches({ output: "result.n", equals: "1" }, value)).toBe(false);
    expect(conditionMatches({ output: "result.nested.ok", equals: true }, value)).toBe(true);
    expect(conditionMatches({ output: "result", equals: "revise" }, "revise")).toBe(true);
  });

  it("matches nothing on a missing key or through an array", () => {
    expect(conditionMatches({ output: "result.missing", equals: null }, { a: 1 })).toBe(false);
    expect(resolveOutputPath({ list: ["a"] }, ["list", "0"])).toEqual({ found: false });
    expect(conditionMatches({ output: "result.decision", equals: "x" }, null)).toBe(false);
  });
});

describe("loading value edges", () => {
  it("a three-way route loads", async () => {
    const dir = await tempDir();
    const file = await writeAt(dir, "f.yaml", threeWay());
    const { factory, warnings } = await loadFactory(file, dir);
    expect(factory.edges.filter((e) => typeof e.when === "object")).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  it("refuses an output key the from node does not declare", async () => {
    const err = await loadErr(
      threeWay({
        edges:
          "  - { from: evaluate, to: verify, when: { output: verdict.decision, equals: x } }\n",
      }),
    );
    expect(err.message).toMatch(
      /tests output "verdict", which must be a `type: value` output of node "evaluate"; the node does not declare it/,
    );
  });

  it("refuses a file output", async () => {
    const err = await loadErr(threeWay({ outputs: "{ result: { type: file } }" }));
    expect(err.message).toMatch(/declares it as type file/);
  });

  it("refuses a path ruled out by additionalProperties: false, naming node, edge and path", async () => {
    const err = await loadErr(
      threeWay({
        edges:
          "  - { from: evaluate, to: verify, when: { output: result.verdict, equals: approve } }\n",
      }),
    );
    expect(err.message).toContain('evaluate → verify (when output:result.verdict="approve")');
    expect(err.message).toMatch(
      /path "result.verdict", which cannot exist: .*additionalProperties: false.*"verdict"/,
    );
  });

  it("refuses a path through a non-object type", async () => {
    const err = await loadErr(
      threeWay({
        outputs:
          "{ result: { type: value, schema: { type: object, properties: { decision: { type: string } } } } }",
        edges:
          "  - { from: evaluate, to: verify, when: { output: result.decision.kind, equals: a } }\n",
      }),
    );
    expect(err.message).toMatch(/at "decision" has type "string", so it has no property "kind"/);
  });

  it("refuses a path under a false schema", async () => {
    const err = await loadErr(
      threeWay({
        outputs: "{ result: { type: value, schema: { properties: { decision: false } } } }",
        edges: "  - { from: evaluate, to: verify, when: { output: result.decision, equals: a } }\n",
      }),
    );
    expect(err.message).toMatch(/cannot exist: the schema at the path is `false`/);
  });

  it("refuses an equals or in value outside the leaf enum or const", async () => {
    const enumErr = await loadErr(
      threeWay({
        edges:
          "  - { from: evaluate, to: verify, when: { output: result.decision, equals: aprove } }\n",
      }),
    );
    expect(enumErr.message).toMatch(/for "aprove", which its schema's enum\/const never allows/);
    const inErr = await loadErr(
      threeWay({
        edges:
          "  - { from: evaluate, to: verify, when: { output: result.decision, in: [approve, ok] } }\n",
      }),
    );
    expect(inErr.message).toMatch(/for "ok", which/);
    const constErr = await loadErr(
      threeWay({
        outputs: "{ result: { type: value, schema: { properties: { decision: { const: go } } } } }",
        edges:
          "  - { from: evaluate, to: verify, when: { output: result.decision, equals: stop } }\n",
      }),
    );
    expect(constErr.message).toMatch(/for "stop"/);
  });

  it("loads a path the schema permits or cannot decide", async () => {
    const dir = await tempDir();
    const cases = [
      // No schema at all.
      "{ result: { type: value } }",
      // Open object: any property may exist.
      "{ result: { type: value, schema: { type: object } } }",
      // Behind $ref / anyOf: not decided, so accepted.
      "{ result: { type: value, schema: { $defs: { d: { additionalProperties: false } }, $ref: '#/$defs/d' } } }",
      "{ result: { type: value, schema: { anyOf: [{ additionalProperties: false }] } } }",
      // patternProperties under additionalProperties: false.
      "{ result: { type: value, schema: { additionalProperties: false, patternProperties: { '^deci': { enum: [approve, revise] } } } } }",
    ];
    for (const [i, outputs] of cases.entries()) {
      const file = await writeAt(
        dir,
        `ok-${i}.yaml`,
        threeWay({
          outputs,
          edges:
            "  - { from: evaluate, to: verify, when: { output: result.decision, equals: approve } }\n",
        }),
      );
      await expect(loadFactory(file, dir)).resolves.toBeDefined();
    }
  });

  it("honours a step-declared outputs schema on a uses: node", async () => {
    const repo = await tempDir();
    await writeAt(
      repo,
      "examples/steps/judge.yaml",
      `name: judge
version: "1.0.0"
executor: claude
with:
  prompt: "Judge."
outputs:
  result:
    type: value
    required: true
    schema: ${DECISION_SCHEMA}
`,
    );
    const yaml = (equals: string) => `name: f
nodes:
  evaluate:
    uses: minifac:judge
  verify:
    executor: claude
    terminal: true
edges:
  - { from: evaluate, to: verify, when: { output: result.decision, equals: ${equals} } }
`;
    const ok = await writeAt(repo, "ok.yaml", yaml("approve"));
    await expect(loadFactory(ok, repo)).resolves.toBeDefined();
    const bad = await writeAt(repo, "bad.yaml", yaml("maybe"));
    const err = await loadFactory(bad, repo).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FactoryLoadError);
    expect((err as FactoryLoadError).message).toMatch(/for "maybe"/);
  });

  it("refuses two same-path edges with overlapping values, naming both", async () => {
    const err = await loadErr(
      threeWay({
        edges: `  - { from: evaluate, to: implement, max_traversals: 2, when: { output: result.decision, equals: revise } }
  - { from: evaluate, to: escalate, when: { output: result.decision, in: [revise, escalate] } }
`,
      }),
    );
    expect(err.message).toContain(
      'evaluate → implement (when output:result.decision="revise") and evaluate → escalate (when output:result.decision in ["revise","escalate"])',
    );
    expect(err.message).toMatch(/both match "result.decision" = "revise"/);
  });

  it("loads same-path edges with disjoint values, and edges on different paths", async () => {
    const dir = await tempDir();
    const file = await writeAt(
      dir,
      "f.yaml",
      threeWay({
        outputs: "{ result: { type: value } }",
        edges: `  - { from: evaluate, to: verify, when: { output: result.decision, equals: approve } }
  - { from: evaluate, to: escalate, when: { output: result.decision, in: [escalate, stop] } }
  - { from: evaluate, to: escalate, when: { output: result.risk, equals: high } }
`,
      }),
    );
    await expect(loadFactory(file, dir)).resolves.toBeDefined();
  });
});
