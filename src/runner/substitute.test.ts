import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Brief } from "../brief/loader.js";
import type { NodeResult } from "../executor/types.js";
import {
  PRIOR_RESULTS_READ_CAP,
  TemplateSubstitutionError,
  substitute,
  substituteBriefTokens,
} from "./substitute.js";

function brief(overrides: Partial<Brief> = {}): Brief {
  return {
    frontmatter: {
      change: "my-change",
      factory: "sdd",
      ...overrides.frontmatter,
    },
    body: "the body",
    sourcePath: "/repo/inputs/my-change.md",
    ...overrides,
  };
}

describe("substituteBriefTokens", () => {
  it("substitutes a single change token", () => {
    expect(substituteBriefTokens("Work on {{ brief.change }}.", brief())).toBe(
      "Work on my-change.",
    );
  });

  it("substitutes the body preserving newlines and markdown", () => {
    const b = brief({ body: "## Heading\n\n- bullet\n- another" });
    expect(substituteBriefTokens("## Intent\n\n{{ brief.body }}", b)).toBe(
      "## Intent\n\n## Heading\n\n- bullet\n- another",
    );
  });

  it("substitutes the empty string for an absent optional field", () => {
    expect(substituteBriefTokens("Base: {{ brief.base_branch }}.", brief())).toBe("Base: .");
  });

  it("substitutes a present optional field's value", () => {
    const b = brief({ frontmatter: { change: "c", factory: "sdd", base_branch: "main" } });
    expect(substituteBriefTokens("Base: {{ brief.base_branch }}.", b)).toBe("Base: main.");
  });

  it("leaves unknown identifiers verbatim", () => {
    expect(substituteBriefTokens("Future: {{ brief.depends_on }}.", brief())).toBe(
      "Future: {{ brief.depends_on }}.",
    );
  });

  it("returns a tokenless prompt unchanged", () => {
    const prompt = "Say hello in one sentence.";
    expect(substituteBriefTokens(prompt, brief())).toBe(prompt);
  });

  it("tolerates whitespace inside braces", () => {
    expect(substituteBriefTokens("{{brief.change}}", brief())).toBe("my-change");
    expect(substituteBriefTokens("{{   brief.change   }}", brief())).toBe("my-change");
  });

  it("substitutes multiple tokens in one prompt", () => {
    expect(
      substituteBriefTokens(
        "{{ brief.change }} / {{ brief.factory }} / {{ brief.change }}",
        brief(),
      ),
    ).toBe("my-change / sdd / my-change");
  });
});

describe("substitute (Substitutions record)", () => {
  it("substitutes {{ run.cwd }} when run is in scope", () => {
    expect(substitute("cd {{ run.cwd }}", { run: { cwd: "/wt/foo" } })).toBe("cd /wt/foo");
  });

  it("leaves {{ run.cwd }} verbatim when no run in scope", () => {
    expect(substitute("cd {{ run.cwd }}", {})).toBe("cd {{ run.cwd }}");
  });

  it("leaves unknown run.* field verbatim", () => {
    expect(substitute("id={{ run.id }}", { run: { cwd: "/wt" } })).toBe("id={{ run.id }}");
  });

  it("preserves brief semantics under the new signature", () => {
    const b: Brief = {
      frontmatter: { change: "foo", factory: "sdd" },
      body: "",
      sourcePath: "/x.md",
    };
    expect(substitute("{{ brief.change }}", { brief: b })).toBe("foo");
    expect(substitute("{{ brief.change }}", {})).toBe("{{ brief.change }}");
  });

  it("substitutes both brief and run tokens in a single string", () => {
    const b: Brief = {
      frontmatter: { change: "foo", factory: "sdd" },
      body: "",
      sourcePath: "/x.md",
    };
    expect(substitute("{{ brief.change }}@{{ run.cwd }}", { brief: b, run: { cwd: "/wt" } })).toBe(
      "foo@/wt",
    );
  });

  it("tolerates whitespace around run.<field>", () => {
    expect(substitute("{{run.cwd}}", { run: { cwd: "/x" } })).toBe("/x");
    expect(substitute("{{   run.cwd   }}", { run: { cwd: "/x" } })).toBe("/x");
  });

  it("leaves unknown namespaces verbatim", () => {
    expect(substitute("{{ env.HOME }}", { run: { cwd: "/x" } })).toBe("{{ env.HOME }}");
  });
});

describe("substitute inputs namespace", () => {
  it("substitutes a string input value", () => {
    expect(substitute("Work on {{ inputs.change }}.", { inputs: { change: "foo" } })).toBe(
      "Work on foo.",
    );
  });

  it("stringifies a number input", () => {
    expect(substitute("Run {{ inputs.iterations }} times.", { inputs: { iterations: 3 } })).toBe(
      "Run 3 times.",
    );
  });

  it("stringifies a boolean input", () => {
    expect(substitute("Dry run: {{ inputs.dry_run }}.", { inputs: { dry_run: true } })).toBe(
      "Dry run: true.",
    );
  });

  it("JSON-stringifies an array input", () => {
    expect(
      substitute("Commands: {{ inputs.commands }}.", {
        inputs: { commands: ["npm test", "npm run build"] },
      }),
    ).toBe('Commands: ["npm test","npm run build"].');
  });

  it("JSON-stringifies an object input", () => {
    expect(substitute("Config: {{ inputs.cfg }}.", { inputs: { cfg: { mode: "fast" } } })).toBe(
      'Config: {"mode":"fast"}.',
    );
  });

  it("absent optional input → empty string", () => {
    expect(substitute("Model: {{ inputs.model }}.", { inputs: {} })).toBe("Model: .");
  });

  it("null input → empty string", () => {
    expect(substitute("Note: {{ inputs.note }}.", { inputs: { note: null } })).toBe("Note: .");
  });

  it("inline node (no inputs map) leaves inputs.* verbatim", () => {
    expect(substitute("Foo: {{ inputs.bar }}.", {})).toBe("Foo: {{ inputs.bar }}.");
  });

  it("inputs and brief cooperate when input value is a brief token", () => {
    const b: Brief = {
      frontmatter: { change: "foo", factory: "sdd" },
      body: "",
      sourcePath: "/x.md",
    };
    expect(
      substitute("Work on {{ inputs.change }}.", {
        brief: b,
        inputs: { change: "{{ brief.change }}" },
      }),
    ).toBe("Work on foo.");
  });

  it("tolerates whitespace around inputs.<field>", () => {
    expect(substitute("{{inputs.x}}", { inputs: { x: "v" } })).toBe("v");
    expect(substitute("{{   inputs.x   }}", { inputs: { x: "v" } })).toBe("v");
  });
});

function nodeResult(nodeId: string, outputs: NodeResult["outputs"], iteration = 1): NodeResult {
  return {
    nodeId,
    iteration,
    status: "succeeded",
    reason: null,
    startedAt: 0,
    endedAt: 1,
    outputs,
  };
}

describe("substitute run.outputs_dir", () => {
  it("substitutes outputs_dir when present in run", () => {
    expect(
      substitute("Write to {{ run.outputs_dir }}/findings.json.", {
        run: { outputsDir: "/abs/.minifac/outputs/abc/propose/1" },
      }),
    ).toBe("Write to /abs/.minifac/outputs/abc/propose/1/findings.json.");
  });

  it("leaves outputs_dir verbatim when not in scope", () => {
    expect(substitute("cd {{ run.outputs_dir }}", {})).toBe("cd {{ run.outputs_dir }}");
  });

  it("cwd and outputs_dir in the same string both substitute", () => {
    expect(
      substitute("cwd={{ run.cwd }} out={{ run.outputs_dir }}", {
        run: { cwd: "/wt", outputsDir: "/out" },
      }),
    ).toBe("cwd=/wt out=/out");
  });
});

describe("substitute priorResults.<id>.outputs.<key>", () => {
  it("substitutes the absolute path when output is present", () => {
    const map = new Map<string, NodeResult>([
      [
        "propose",
        nodeResult("propose", {
          findings: { type: "value", path: "/p/findings.json", size: 10, mtime: 1 },
        }),
      ],
    ]);
    expect(
      substitute("Read {{ priorResults.propose.outputs.findings }} for context.", {
        priorResults: map,
      }),
    ).toBe("Read /p/findings.json for context.");
  });

  it("substitutes empty string when no prior result exists", () => {
    expect(
      substitute("{{ priorResults.nonexistent.outputs.findings }}", { priorResults: new Map() }),
    ).toBe("");
  });

  it("substitutes empty string when key is not in output index", () => {
    const map = new Map<string, NodeResult>([["propose", nodeResult("propose", {})]]);
    expect(substitute("{{ priorResults.propose.outputs.findings }}", { priorResults: map })).toBe(
      "",
    );
  });

  it("substitutes empty string when outputs is null on the prior result", () => {
    const map = new Map<string, NodeResult>([["propose", nodeResult("propose", null)]]);
    expect(substitute("{{ priorResults.propose.outputs.findings }}", { priorResults: map })).toBe(
      "",
    );
  });

  it(":read suffix inlines small file contents", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "subs-read-"));
    const filePath = path.join(dir, "findings.json");
    const contents = '{"items":["a","b"]}';
    await writeFile(filePath, contents, "utf8");
    const map = new Map<string, NodeResult>([
      [
        "propose",
        nodeResult("propose", {
          findings: { type: "value", path: filePath, size: contents.length, mtime: 1 },
        }),
      ],
    ]);
    expect(
      substitute("Findings:\n{{ priorResults.propose.outputs.findings:read }}\nEnd.", {
        priorResults: map,
      }),
    ).toBe(`Findings:\n${contents}\nEnd.`);
  });

  it(":read suffix on oversize file throws", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "subs-read-big-"));
    const filePath = path.join(dir, "big.json");
    const big = "x".repeat(PRIOR_RESULTS_READ_CAP + 100);
    await writeFile(filePath, big, "utf8");
    const map = new Map<string, NodeResult>([
      [
        "propose",
        nodeResult("propose", {
          findings: { type: "value", path: filePath, size: big.length, mtime: 1 },
        }),
      ],
    ]);
    expect(() =>
      substitute("{{ priorResults.propose.outputs.findings:read }}", {
        priorResults: map,
      }),
    ).toThrowError(TemplateSubstitutionError);
  });

  it(":read on a directory output throws", () => {
    const map = new Map<string, NodeResult>([
      [
        "verify",
        nodeResult("verify", {
          logs: { type: "directory", path: "/some/dir", size: 100, mtime: 1 },
        }),
      ],
    ]);
    expect(() =>
      substitute("{{ priorResults.verify.outputs.logs:read }}", { priorResults: map }),
    ).toThrowError(/directory/);
  });

  it("node id may contain hyphens", () => {
    const map = new Map<string, NodeResult>([
      [
        "my-node",
        nodeResult("my-node", {
          x: { type: "value", path: "/x.json", size: 1, mtime: 1 },
        }),
      ],
    ]);
    expect(substitute("{{ priorResults.my-node.outputs.x }}", { priorResults: map })).toBe(
      "/x.json",
    );
  });

  it("tolerates whitespace around the token", () => {
    const map = new Map<string, NodeResult>([
      [
        "n",
        nodeResult("n", {
          k: { type: "value", path: "/k.json", size: 1, mtime: 1 },
        }),
      ],
    ]);
    expect(substitute("{{   priorResults.n.outputs.k   }}", { priorResults: map })).toBe("/k.json");
  });
});
