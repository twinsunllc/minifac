import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBriefAndAncestorsCleanliness,
  checkBriefCleanliness,
} from "./cleanliness.js";
import { loadBrief } from "./loader.js";
import { BriefCycleError } from "./state.js";

function sh(cwd: string, args: string[]): void {
  const r = spawnSync(args[0] as string, args.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${r.stderr}`);
  }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-clean-"));
  sh(dir, ["git", "init", "-q", "-b", "main"]);
  sh(dir, ["git", "config", "user.email", "test@example.com"]);
  sh(dir, ["git", "config", "user.name", "Test"]);
  sh(dir, ["git", "config", "commit.gpgsign", "false"]);
  sh(dir, ["git", "config", "core.hooksPath", "/dev/null"]);
  await mkdir(path.join(dir, "inputs"), { recursive: true });
  // Seed a real commit so HEAD exists.
  await writeFile(path.join(dir, "README.md"), "hi\n");
  sh(dir, ["git", "add", "README.md"]);
  sh(dir, ["git", "commit", "-q", "-m", "init"]);
  return dir;
}

async function writeBriefFile(
  repo: string,
  change: string,
  depends_on: string[] = [],
): Promise<string> {
  const deps =
    depends_on.length === 0
      ? ""
      : `depends_on:\n${depends_on.map((d) => `  - ${d}`).join("\n")}\n`;
  const fp = path.join(repo, "inputs", `${change}.md`);
  await writeFile(fp, `---\nchange: ${change}\nfactory: sdd\n${deps}---\nbody\n`, "utf8");
  return fp;
}

async function commitAll(repo: string, msg = "snapshot"): Promise<void> {
  sh(repo, ["git", "add", "-A"]);
  sh(repo, ["git", "commit", "-q", "-m", msg]);
}

describe("checkBriefCleanliness", () => {
  it("committed brief is clean", async () => {
    const repo = await makeRepo();
    const fp = await writeBriefFile(repo, "foo");
    await commitAll(repo);
    const r = await checkBriefCleanliness(fp, repo);
    expect(r).toEqual({ status: "clean" });
  });

  it("untracked brief is unclean with code '??'", async () => {
    const repo = await makeRepo();
    const fp = await writeBriefFile(repo, "foo");
    const r = await checkBriefCleanliness(fp, repo);
    expect(r).toEqual({ status: "unclean", code: "??" });
  });

  it("modified-but-tracked brief is unclean with code ' M'", async () => {
    const repo = await makeRepo();
    const fp = await writeBriefFile(repo, "foo");
    await commitAll(repo);
    await writeFile(fp, "---\nchange: foo\nfactory: sdd\n---\nedited\n", "utf8");
    const r = await checkBriefCleanliness(fp, repo);
    expect(r).toEqual({ status: "unclean", code: " M" });
  });

  it("staged-but-uncommitted brief is unclean with code 'A '", async () => {
    const repo = await makeRepo();
    const fp = await writeBriefFile(repo, "foo");
    sh(repo, ["git", "add", fp]);
    const r = await checkBriefCleanliness(fp, repo);
    expect(r).toEqual({ status: "unclean", code: "A " });
  });

  it("non-git directory yields disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "minifac-clean-no-git-"));
    await mkdir(path.join(dir, "inputs"), { recursive: true });
    const fp = path.join(dir, "inputs", "foo.md");
    await writeFile(fp, "---\nchange: foo\nfactory: sdd\n---\nbody\n", "utf8");
    const r = await checkBriefCleanliness(fp, dir);
    expect(r).toEqual({ status: "disabled", reason: "not-a-git-repo" });
  });
});

describe("checkBriefAndAncestorsCleanliness", () => {
  it("clean brief with no deps returns clean", async () => {
    const repo = await makeRepo();
    await writeBriefFile(repo, "foo");
    await commitAll(repo);
    const brief = await loadBrief("foo", repo);
    const r = await checkBriefAndAncestorsCleanliness(brief, {
      inputsDir: path.join(repo, "inputs"),
      repoRoot: repo,
      loadBrief: (c) => loadBrief(c, repo),
    });
    expect(r).toEqual({ status: "clean" });
  });

  it("unclean root brief surfaces itself", async () => {
    const repo = await makeRepo();
    const fp = await writeBriefFile(repo, "foo");
    await commitAll(repo);
    await writeFile(fp, "---\nchange: foo\nfactory: sdd\n---\nedited\n", "utf8");
    const brief = await loadBrief("foo", repo);
    const r = await checkBriefAndAncestorsCleanliness(brief, {
      inputsDir: path.join(repo, "inputs"),
      repoRoot: repo,
      loadBrief: (c) => loadBrief(c, repo),
    });
    expect(r).toEqual({ status: "unclean", offending: "foo", code: " M" });
  });

  it("unclean ancestor is surfaced by name", async () => {
    const repo = await makeRepo();
    await writeBriefFile(repo, "bar"); // untracked
    await writeBriefFile(repo, "foo", ["bar"]);
    // Commit only foo so foo is clean and bar is untracked.
    sh(repo, ["git", "add", path.join("inputs", "foo.md")]);
    sh(repo, ["git", "commit", "-q", "-m", "add foo"]);
    const brief = await loadBrief("foo", repo);
    const r = await checkBriefAndAncestorsCleanliness(brief, {
      inputsDir: path.join(repo, "inputs"),
      repoRoot: repo,
      loadBrief: (c) => loadBrief(c, repo),
    });
    expect(r).toEqual({ status: "unclean", offending: "bar", code: "??" });
  });

  it("first unclean ancestor by topological proximity wins", async () => {
    const repo = await makeRepo();
    await writeBriefFile(repo, "baz"); // untracked
    await writeBriefFile(repo, "bar", ["baz"]); // untracked
    await writeBriefFile(repo, "foo", ["bar"]);
    sh(repo, ["git", "add", path.join("inputs", "foo.md")]);
    sh(repo, ["git", "commit", "-q", "-m", "foo only"]);
    const brief = await loadBrief("foo", repo);
    const r = await checkBriefAndAncestorsCleanliness(brief, {
      inputsDir: path.join(repo, "inputs"),
      repoRoot: repo,
      loadBrief: (c) => loadBrief(c, repo),
    });
    // `bar` is the direct ancestor; it should be reported before `baz`.
    expect(r).toEqual({ status: "unclean", offending: "bar", code: "??" });
  });

  it("sentinel deps are ignored", async () => {
    const repo = await makeRepo();
    await writeBriefFile(repo, "foo", ["callback-status-signaling-design-pending"]);
    await commitAll(repo);
    const brief = await loadBrief("foo", repo);
    const r = await checkBriefAndAncestorsCleanliness(brief, {
      inputsDir: path.join(repo, "inputs"),
      repoRoot: repo,
      loadBrief: (c) => loadBrief(c, repo),
    });
    expect(r).toEqual({ status: "clean" });
  });

  it("cycle throws BriefCycleError", async () => {
    const repo = await makeRepo();
    await writeBriefFile(repo, "a", ["b"]);
    await writeBriefFile(repo, "b", ["a"]);
    await commitAll(repo);
    const brief = await loadBrief("a", repo);
    await expect(
      checkBriefAndAncestorsCleanliness(brief, {
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        loadBrief: (c) => loadBrief(c, repo),
      }),
    ).rejects.toBeInstanceOf(BriefCycleError);
  });

  it("disabled gate short-circuits the walk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "minifac-clean-no-git-"));
    await mkdir(path.join(dir, "inputs"), { recursive: true });
    await writeFile(
      path.join(dir, "inputs", "foo.md"),
      "---\nchange: foo\nfactory: sdd\ndepends_on:\n  - bar\n---\nbody\n",
      "utf8",
    );
    await writeFile(
      path.join(dir, "inputs", "bar.md"),
      "---\nchange: bar\nfactory: sdd\n---\nbody\n",
      "utf8",
    );
    let probed = 0;
    const brief = await loadBrief("foo", dir);
    const r = await checkBriefAndAncestorsCleanliness(brief, {
      inputsDir: path.join(dir, "inputs"),
      repoRoot: dir,
      loadBrief: (c) => loadBrief(c, dir),
      runner: async (...args) => {
        probed += 1;
        const { runGit } = await import("../worktree/git.js");
        return runGit(args[0], ["status", "--porcelain", "--", args[1]]);
      },
    });
    expect(r).toEqual({ status: "disabled" });
    // The walk short-circuits after the first disabled return — only the
    // root brief is probed, never the ancestor.
    expect(probed).toBe(1);
  });
});
