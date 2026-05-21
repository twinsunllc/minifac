import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeBriefDoneness } from "./doneness.js";

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "minifac-doneness-"));
  await mkdir(path.join(repo, "inputs"), { recursive: true });
  return repo;
}

async function writeBrief(repo: string, rel: string): Promise<string> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, "---\nchange: x\nfactory: sdd\n---\n", "utf8");
  return full;
}

describe("computeBriefDoneness", () => {
  it("returns active when only inputs/<name>.md exists", async () => {
    const repo = await makeRepo();
    const file = await writeBrief(repo, "inputs/foo.md");
    const res = computeBriefDoneness("foo", {
      inputsDir: path.join(repo, "inputs"),
      repoRoot: repo,
    });
    expect(res.doneness).toBe("active");
    expect(res.filePath).toBe(file);
  });

  it("returns done when only inputs/done/<name>.md exists", async () => {
    const repo = await makeRepo();
    const file = await writeBrief(repo, "inputs/done/foo.md");
    const res = computeBriefDoneness("foo", {
      inputsDir: path.join(repo, "inputs"),
      repoRoot: repo,
    });
    expect(res.doneness).toBe("done");
    expect(res.filePath).toBe(file);
  });

  it("returns missing when neither exists", () => {
    const res = computeBriefDoneness("ghost", {
      inputsDir: path.join(tmpdir(), "no-such-dir-xyz"),
      repoRoot: tmpdir(),
    });
    expect(res.doneness).toBe("missing");
    expect(res.filePath).toBeUndefined();
  });

  it("active wins when both locations have the file", async () => {
    const repo = await makeRepo();
    const active = await writeBrief(repo, "inputs/foo.md");
    await writeBrief(repo, "inputs/done/foo.md");
    const res = computeBriefDoneness("foo", {
      inputsDir: path.join(repo, "inputs"),
      repoRoot: repo,
    });
    expect(res.doneness).toBe("active");
    expect(res.filePath).toBe(active);
  });
});
