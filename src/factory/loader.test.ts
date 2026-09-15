import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FactoryLoadError, loadFactory } from "./loader.js";
import { startNodeIds } from "./start-nodes.js";

const tmpDirs: string[] = [];

async function writeFactory(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-test-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, name);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

afterEach(() => {
  // cleanup is best-effort; test dirs are in tmp and won't leak meaningfully
});

describe("loadFactory", () => {
  it("loads a minimal valid factory", async () => {
    const file = await writeFactory(
      "ok.yaml",
      `name: simple
nodes:
  a:
    executor: claude
    terminal: true
edges: []
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.name).toBe("simple");
    expect(loaded.factory.nodes.a?.executor).toBe("claude");
    expect(loaded.factory.nodes.a?.terminal).toBe(true);
    expect(loaded.factory.edges).toEqual([]);
    expect(loaded.sourcePath).toBe(file);
    expect(loaded.sourceDir).toBe(path.dirname(file));
  });

  it("rejects camelCase keys", async () => {
    const file = await writeFactory(
      "camel.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    terminal: true
    maxIterations: 3
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/maxIterations/);
  });

  it("rejects a node missing executor", async () => {
    const file = await writeFactory(
      "noexec.yaml",
      `name: bad
nodes:
  a:
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/executor/);
  });

  it("rejects unknown top-level node keys", async () => {
    const file = await writeFactory(
      "extra.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    terminal: true
    retry: 3
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/retry/);
  });

  it("accepts opaque `with:`", async () => {
    const file = await writeFactory(
      "with.yaml",
      `name: ok
nodes:
  a:
    executor: claude
    terminal: true
    with:
      prompt: hello
      anything: { nested: true }
edges: []
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.nodes.a?.with).toEqual({
      prompt: "hello",
      anything: { nested: true },
    });
  });

  it("rejects edges referencing undeclared `to`", async () => {
    const file = await writeFactory(
      "badedge.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    terminal: true
edges:
  - from: a
    to: ghost
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/ghost/);
  });

  it("rejects unknown `when` value", async () => {
    const file = await writeFactory(
      "badwhen.yaml",
      `name: bad
nodes:
  a:
    executor: claude
  b:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
    when: on_weekend
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/when/);
  });

  it("rejects unbounded cycles", async () => {
    // a is the declared start node (b loops back into it on_failure, so it
    // needs `start: true`); no budget on either the edge or a node in the
    // cycle.
    const file = await writeFactory(
      "cycle.yaml",
      `name: cyc
nodes:
  a:
    executor: claude
    start: true
  b:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
  - from: b
    to: a
    when: on_failure
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/cycle/i);
  });

  it("accepts cycles covered by an edge max_traversals", async () => {
    const file = await writeFactory(
      "ok-cycle.yaml",
      `name: cyc-ok
nodes:
  a:
    executor: claude
    start: true
  b:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
  - from: b
    to: a
    max_traversals: 3
    when: on_failure
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.name).toBe("cyc-ok");
  });

  it("accepts cycles covered by a node max_iterations", async () => {
    const file = await writeFactory(
      "ok-cycle-node.yaml",
      `name: cyc-ok-node
nodes:
  a:
    executor: claude
    start: true
    max_iterations: 3
  b:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
  - from: b
    to: a
    when: on_failure
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.nodes.a?.max_iterations).toBe(3);
  });

  it("rejects factories with no terminal node", async () => {
    const file = await writeFactory(
      "noterm.yaml",
      `name: bad
nodes:
  a:
    executor: claude
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/terminal/i);
  });

  it("rejects factories with no start node, naming the entry cycle and the fix", async () => {
    // closed loop of two nodes — both have inbound, neither is a start node
    const file = await writeFactory(
      "nostart.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    max_iterations: 2
  b:
    executor: claude
    terminal: true
    max_iterations: 2
edges:
  - from: a
    to: b
  - from: b
    to: a
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/no start node/i);
    await expect(loadFactory(file)).rejects.toThrowError(/a → b/);
    await expect(loadFactory(file)).rejects.toThrowError(/start: true/);
  });

  it("a node reachable only by an on_failure edge is not a start node (no load error, not dispatched)", async () => {
    // Issue #36 / FINDINGS F6: a → b, b → ask (on_failure), b → z. `ask`
    // has an inbound edge, so it is not a start node; `a` alone is.
    const file = await writeFactory(
      "escalation.yaml",
      `name: esc
nodes:
  a:
    executor: claude
  b:
    executor: claude
  ask:
    executor: claude
    terminal: true
  z:
    executor: claude
    terminal: true
edges:
  - from: a
    to: b
  - from: b
    to: ask
    when: on_failure
  - from: b
    to: z
`,
    );
    const loaded = await loadFactory(file);
    expect(startNodeIds(loaded.factory)).toEqual(["a"]);
  });

  it("a cycle with an on_failure back-edge into its entry needs `start: true` on the entry", async () => {
    const body = (startLine: string) => `name: pv
nodes:
  p:
    executor: claude${startLine}
  v:
    executor: claude
    terminal: true
edges:
  - from: p
    to: v
  - from: v
    to: p
    when: on_failure
    max_traversals: 2
`;
    const bare = await writeFactory("pv-bare.yaml", body(""));
    await expect(loadFactory(bare)).rejects.toThrowError(/no start node/i);
    await expect(loadFactory(bare)).rejects.toThrowError(/p → v/);

    const declared = await writeFactory("pv-start.yaml", body("\n    start: true"));
    const loaded = await loadFactory(declared);
    expect(loaded.factory.nodes.p?.start).toBe(true);
    expect(startNodeIds(loaded.factory)).toEqual(["p"]);
  });

  it("a self-loop does not disqualify a start node", async () => {
    const file = await writeFactory(
      "selfloop.yaml",
      `name: retry
nodes:
  a:
    executor: claude
    max_iterations: 3
  t:
    executor: claude
    terminal: true
edges:
  - from: a
    to: a
    when: on_failure
  - from: a
    to: t
`,
    );
    const loaded = await loadFactory(file);
    expect(startNodeIds(loaded.factory)).toEqual(["a"]);
  });

  it("rejects a non-boolean `start:`", async () => {
    const file = await writeFactory(
      "badstart.yaml",
      `name: bad
nodes:
  a:
    executor: claude
    terminal: true
    start: yes please
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/start/);
  });

  it("reports a line number for malformed YAML", async () => {
    // Unterminated flow mapping → genuine YAML parse error with line info.
    const file = await writeFactory(
      "broken.yaml",
      `name: broken
nodes:
  a:
    executor: claude
    terminal: true
edges: []
extra: { open
`,
    );
    try {
      await loadFactory(file);
      throw new Error("expected loadFactory to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FactoryLoadError);
      const fe = err as FactoryLoadError;
      // The yaml parser surfaces a line number; the wrapped error includes it.
      expect(fe.location?.line).toBeGreaterThan(0);
    }
  });

  it("reports a clear error when the file is missing", async () => {
    await expect(
      loadFactory(path.join(tmpdir(), "no-such-minifac-factory-xyz.yaml")),
    ).rejects.toThrowError(/Could not read/);
  });

  it("defaults the top-level `brief:` field to `required` when omitted", async () => {
    const file = await writeFactory(
      "default-brief.yaml",
      `name: f
nodes:
  a:
    executor: claude
    terminal: true
edges: []
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.brief).toBe("required");
  });

  it("accepts `brief: optional`", async () => {
    const file = await writeFactory(
      "opt-brief.yaml",
      `name: f
brief: optional
nodes:
  a:
    executor: claude
    terminal: true
edges: []
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.brief).toBe("optional");
  });

  it("accepts `brief: none`", async () => {
    const file = await writeFactory(
      "none-brief.yaml",
      `name: f
brief: none
nodes:
  a:
    executor: claude
    terminal: true
edges: []
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.brief).toBe("none");
  });

  it("rejects an unknown `brief:` literal", async () => {
    const file = await writeFactory(
      "bad-brief.yaml",
      `name: f
brief: yolo
nodes:
  a:
    executor: claude
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/brief/);
  });

  it("still rejects unknown top-level keys (strict)", async () => {
    const file = await writeFactory(
      "extra-top.yaml",
      `name: f
briefs: required
nodes:
  a:
    executor: claude
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/briefs/);
  });
});

describe("loadFactory — node `resume:`", () => {
  it("loads a node declaring `resume:` alongside executor + with", async () => {
    const file = await writeFactory(
      "resume-ok.yaml",
      `name: cascade
nodes:
  plan:
    executor: claude
    with:
      prompt: explore
  apply:
    executor: claude
    resume: plan
    terminal: true
    with:
      prompt: continue
      model: cheap-model
edges:
  - from: plan
    to: apply
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.nodes.apply?.resume).toBe("plan");
    expect(loaded.factory.nodes.plan?.resume).toBeUndefined();
  });

  it("rejects `resume:` naming an undeclared node", async () => {
    const file = await writeFactory(
      "resume-unknown.yaml",
      `name: cascade
nodes:
  plan:
    executor: claude
  apply:
    executor: claude
    resume: explore
    terminal: true
edges:
  - from: plan
    to: apply
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(
      /apply.*resume: explore.*no node "explore"/s,
    );
  });

  it("rejects self-resume", async () => {
    const file = await writeFactory(
      "resume-self.yaml",
      `name: cascade
nodes:
  apply:
    executor: claude
    resume: apply
    terminal: true
edges: []
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/cannot resume itself/);
  });

  it("rejects a `resume:` pair whose `cwd` differs", async () => {
    const file = await writeFactory(
      "resume-cwd.yaml",
      `name: cascade
nodes:
  plan:
    executor: claude
    cwd: "{{ run.cwd }}"
  apply:
    executor: claude
    cwd: /other/repo
    resume: plan
    terminal: true
edges:
  - from: plan
    to: apply
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(
      /cwd. differs.*apply.*\/other\/repo.*plan.*run\.cwd/s,
    );
  });

  it("accepts a `resume:` pair that both omit `cwd`", async () => {
    const file = await writeFactory(
      "resume-nocwd.yaml",
      `name: cascade
nodes:
  plan:
    executor: claude
  apply:
    executor: claude
    resume: plan
    terminal: true
edges:
  - from: plan
    to: apply
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.nodes.apply?.resume).toBe("plan");
  });

  it("accepts a `resume:` pair with identical explicit `cwd`", async () => {
    const file = await writeFactory(
      "resume-samecwd.yaml",
      `name: cascade
nodes:
  plan:
    executor: claude
    cwd: "{{ run.cwd }}"
  apply:
    executor: claude
    cwd: "{{ run.cwd }}"
    resume: plan
    terminal: true
edges:
  - from: plan
    to: apply
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.nodes.apply?.resume).toBe("plan");
  });

  it("rejects an empty `resume:` string", async () => {
    const file = await writeFactory(
      "resume-empty.yaml",
      `name: cascade
nodes:
  plan:
    executor: claude
  apply:
    executor: claude
    resume: ""
    terminal: true
edges:
  - from: plan
    to: apply
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/resume/);
  });

  it("rejects a non-string `resume:` value", async () => {
    const file = await writeFactory(
      "resume-nonstring.yaml",
      `name: cascade
nodes:
  plan:
    executor: claude
  apply:
    executor: claude
    resume: [plan]
    terminal: true
edges:
  - from: plan
    to: apply
`,
    );
    await expect(loadFactory(file)).rejects.toThrowError(/resume/);
  });

  it("does NOT reachability-check the target: a later-running target loads fine", async () => {
    // `apply` resumes `verify`, but the only edge into `verify` starts at
    // `apply` — so `verify` cannot have run before `apply`'s first
    // iteration. That's a runtime failure (resume_unavailable), not a load
    // error: the graph is cyclic by design and reachability isn't
    // statically decidable.
    const file = await writeFactory(
      "resume-later.yaml",
      `name: cascade
nodes:
  apply:
    executor: claude
    resume: verify
    start: true
    max_iterations: 2
  verify:
    executor: claude
    terminal: true
edges:
  - from: apply
    to: verify
  - from: verify
    to: apply
    when: on_failure
    max_traversals: 1
`,
    );
    const loaded = await loadFactory(file);
    expect(loaded.factory.nodes.apply?.resume).toBe("verify");
  });
});
