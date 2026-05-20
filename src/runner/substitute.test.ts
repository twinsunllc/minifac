import { describe, expect, it } from "vitest";
import type { Brief } from "../brief/loader.js";
import { substitute, substituteBriefTokens } from "./substitute.js";

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
    expect(
      substitute("{{ brief.change }}@{{ run.cwd }}", { brief: b, run: { cwd: "/wt" } }),
    ).toBe("foo@/wt");
  });

  it("tolerates whitespace around run.<field>", () => {
    expect(substitute("{{run.cwd}}", { run: { cwd: "/x" } })).toBe("/x");
    expect(substitute("{{   run.cwd   }}", { run: { cwd: "/x" } })).toBe("/x");
  });

  it("leaves unknown namespaces verbatim", () => {
    expect(substitute("{{ env.HOME }}", { run: { cwd: "/x" } })).toBe("{{ env.HOME }}");
  });
});
