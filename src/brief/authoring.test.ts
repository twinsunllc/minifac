import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORING_QUESTIONS, type AuthoringAnswers, renderBrief } from "./authoring.js";
import { loadBrief } from "./loader.js";

const REQUIRED_ANSWERS: AuthoringAnswers = {
  change: "demo",
  factory: "sdd",
  background: "Why this change matters.",
  what_to_do: "Do the thing.",
  acceptance_criteria: "Tests pass.",
};

const FULL_ANSWERS: AuthoringAnswers = {
  ...REQUIRED_ANSWERS,
  out_of_scope: "the moon",
  base_branch: "main",
  model: "claude-opus-4-7",
};

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "minifac-authoring-"));
}

describe("AUTHORING_QUESTIONS", () => {
  it("enumerates the eight ids in canonical order", () => {
    expect(AUTHORING_QUESTIONS.map((q) => q.id)).toEqual([
      "change",
      "factory",
      "background",
      "what_to_do",
      "out_of_scope",
      "acceptance_criteria",
      "base_branch",
      "model",
    ]);
  });

  it("marks required questions correctly", () => {
    const required = new Set(AUTHORING_QUESTIONS.filter((q) => q.required).map((q) => q.id));
    expect(required).toEqual(
      new Set(["change", "factory", "background", "what_to_do", "acceptance_criteria"]),
    );
  });

  it("each frontmatter question carries a frontmatterKey; each body-section question carries a bodyHeading", () => {
    for (const q of AUTHORING_QUESTIONS) {
      if (q.applies === "frontmatter") {
        expect(typeof q.frontmatterKey).toBe("string");
      } else {
        expect(typeof q.bodyHeading).toBe("string");
      }
    }
  });
});

describe("renderBrief", () => {
  it("snapshot: full-answer fixture", () => {
    expect(renderBrief(FULL_ANSWERS)).toMatchInlineSnapshot(`
      "---
      change: demo
      factory: sdd
      base_branch: main
      model: claude-opus-4-7
      ---

      ## Background

      Why this change matters.

      ## What to do

      Do the thing.

      ## Out of scope

      the moon

      ## Acceptance criteria

      Tests pass.
      "
    `);
  });

  it("snapshot: required-only fixture", () => {
    expect(renderBrief(REQUIRED_ANSWERS)).toMatchInlineSnapshot(`
      "---
      change: demo
      factory: sdd
      ---

      ## Background

      Why this change matters.

      ## What to do

      Do the thing.

      ## Acceptance criteria

      Tests pass.
      "
    `);
  });

  it("is deterministic", () => {
    expect(renderBrief(FULL_ANSWERS)).toBe(renderBrief(FULL_ANSWERS));
  });

  it("omits optional unanswered frontmatter and body sections", () => {
    const out = renderBrief(REQUIRED_ANSWERS);
    expect(out).not.toMatch(/base_branch:/);
    expect(out).not.toMatch(/model:/);
    expect(out).not.toMatch(/## Out of scope/);
  });

  it("inserts partial-brief marker when incompleteAt is supplied", () => {
    const out = renderBrief({ change: "demo", factory: "sdd" }, { incompleteAt: "background" });
    expect(out).toMatch(/^---\nchange: demo\nfactory: sdd\n---\n/);
    expect(out).toMatch(/> \*\*Note:\*\* Brief is incomplete/);
    expect(out).toMatch(/before the `background` question/);
  });

  it("round-trips through loadBrief (required-only)", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "demo.md");
    await writeFile(file, renderBrief(REQUIRED_ANSWERS), "utf8");
    const brief = await loadBrief(file);
    expect(brief.frontmatter.change).toBe("demo");
    expect(brief.frontmatter.factory).toBe("sdd");
    expect(brief.body).toContain("## Background");
    expect(brief.body).toContain("## What to do");
    expect(brief.body).toContain("## Acceptance criteria");
  });

  it("round-trips through loadBrief (full)", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "full.md");
    await writeFile(file, renderBrief(FULL_ANSWERS), "utf8");
    const brief = await loadBrief(file);
    expect(brief.frontmatter.base_branch).toBe("main");
    expect(brief.frontmatter.model).toBe("claude-opus-4-7");
    expect(brief.body).toContain("## Out of scope");
  });

  it("partial brief loads cleanly through loadBrief", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "partial.md");
    await writeFile(
      file,
      renderBrief({ change: "demo", factory: "sdd" }, { incompleteAt: "background" }),
      "utf8",
    );
    const brief = await loadBrief(file);
    expect(brief.frontmatter.change).toBe("demo");
    expect(brief.body).toMatch(/> \*\*Note:\*\* Brief is incomplete/);
  });

  it("quotes values containing YAML-special characters and they round-trip", async () => {
    const dir = await makeDir();
    const file = path.join(dir, "quoted.md");
    const tricky = "value: with colon # and hash";
    await writeFile(
      file,
      renderBrief({
        ...REQUIRED_ANSWERS,
        change: "demo",
        model: tricky,
      }),
      "utf8",
    );
    const brief = await loadBrief(file);
    expect(brief.frontmatter.model).toBe(tricky);
  });
});
