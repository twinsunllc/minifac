import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BriefLoadError, loadBrief } from "./loader.js";

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "minifac-brief-"));
}

async function writeBrief(dir: string, name: string, contents: string): Promise<string> {
  const filePath = path.join(dir, name);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

describe("loadBrief", () => {
  it("parses frontmatter and body (happy path)", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "foo.md",
      `---
change: foo
factory: sdd
---
# Body

paragraph
`,
    );
    const brief = await loadBrief(file);
    expect(brief.frontmatter.change).toBe("foo");
    expect(brief.frontmatter.factory).toBe("sdd");
    expect(brief.body).toBe("# Body\n\nparagraph\n");
    expect(path.isAbsolute(brief.sourcePath)).toBe(true);
    expect(brief.sourcePath).toBe(file);
  });

  it("resolves a bare name to inputs/<name>.md under cwd", async () => {
    const dir = await makeDir();
    await writeBrief(
      dir,
      path.join("inputs", "my-change.md"),
      `---
change: my-change
factory: sdd
---
body here
`,
    );
    const brief = await loadBrief("my-change", dir);
    expect(brief.frontmatter.change).toBe("my-change");
    expect(brief.sourcePath).toBe(path.resolve(dir, "inputs", "my-change.md"));
  });

  it("uses a path-like input verbatim", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "custom.md",
      `---
change: c
factory: sdd
---
`,
    );
    const brief = await loadBrief(file, dir);
    expect(brief.sourcePath).toBe(file);
  });

  it("rejects missing required field with field name in message", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "missing.md",
      `---
change: c
---
body
`,
    );
    await expect(loadBrief(file)).rejects.toThrowError(/factory/);
  });

  it("rejects wrong-type known field, naming the field", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "badtype.md",
      `---
change: 42
factory: sdd
---
body
`,
    );
    await expect(loadBrief(file)).rejects.toThrowError(/change/);
  });

  it("accepts optional fields when present", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "opt.md",
      `---
change: foo
factory: sdd
base_branch: main
model: claude-opus-4-7
---
`,
    );
    const brief = await loadBrief(file);
    expect(brief.frontmatter.base_branch).toBe("main");
    expect(brief.frontmatter.model).toBe("claude-opus-4-7");
  });

  it("passes unknown extras through verbatim", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "extras.md",
      `---
change: foo
factory: sdd
depends_on:
  - bar
priority: high
---
`,
    );
    const brief = await loadBrief(file);
    expect(brief.frontmatter.change).toBe("foo");
    expect((brief.frontmatter as Record<string, unknown>).depends_on).toEqual(["bar"]);
    expect((brief.frontmatter as Record<string, unknown>).priority).toBe("high");
  });

  it("reports a clear error when the file is missing", async () => {
    const ghost = path.join(tmpdir(), "no-such-minifac-brief-xyz.md");
    await expect(loadBrief(ghost)).rejects.toThrowError(/Could not read/);
  });

  it("rejects a file missing the opening fence", async () => {
    const dir = await makeDir();
    const file = await writeBrief(dir, "no-fence.md", "no frontmatter here\n");
    await expect(loadBrief(file)).rejects.toThrowError(/missing required frontmatter/i);
  });

  it("rejects a file with an unterminated frontmatter", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "no-close.md",
      `---
change: foo
factory: sdd
body without closing fence
`,
    );
    await expect(loadBrief(file)).rejects.toThrowError(/unterminated/i);
  });

  it("accepts an empty body", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "empty-body.md",
      `---
change: foo
factory: sdd
---
`,
    );
    const brief = await loadBrief(file);
    expect(brief.body).toBe("");
  });

  it("reports a line number for malformed YAML in the frontmatter", async () => {
    const dir = await makeDir();
    const file = await writeBrief(
      dir,
      "broken.md",
      `---
change: foo
factory: sdd
extra: { open
---
body
`,
    );
    try {
      await loadBrief(file);
      throw new Error("expected loadBrief to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BriefLoadError);
      const be = err as BriefLoadError;
      expect(be.location?.line).toBeGreaterThan(0);
    }
  });
});
