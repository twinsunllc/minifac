import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorktreeConfig, WorktreeConfigError } from "./config.js";

async function makeDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

describe("loadWorktreeConfig", () => {
  let savedHome: string | undefined;
  let home: string;
  let repo: string;

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    home = await makeDir("minifac-cfg-home-");
    repo = await makeDir("minifac-cfg-repo-");
    process.env.MINIFAC_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = savedHome;
  });

  it("returns defaults when no config files exist", async () => {
    const cfg = await loadWorktreeConfig(repo);
    expect(cfg.worktreesDir).toBe(path.join(home, "worktrees"));
    expect(cfg.locksDir).toBe(path.join(home, "locks"));
    expect(cfg.defaultBranch).toBeUndefined();
  });

  it("honors global-only config", async () => {
    await writeFile(
      path.join(home, "config.yaml"),
      `worktrees_dir: /custom/worktrees
locks_dir: /custom/locks
default_branch: trunk
`,
    );
    const cfg = await loadWorktreeConfig(repo);
    expect(cfg.worktreesDir).toBe("/custom/worktrees");
    expect(cfg.locksDir).toBe("/custom/locks");
    expect(cfg.defaultBranch).toBe("trunk");
  });

  it("honors per-repo-only config", async () => {
    await mkdir(path.join(repo, ".minifac"), { recursive: true });
    await writeFile(
      path.join(repo, ".minifac", "config.yaml"),
      `worktrees_dir: /repo/wt
default_branch: develop
`,
    );
    const cfg = await loadWorktreeConfig(repo);
    expect(cfg.worktreesDir).toBe("/repo/wt");
    expect(cfg.defaultBranch).toBe("develop");
    // locks_dir remains the default since per-repo cannot set it.
    expect(cfg.locksDir).toBe(path.join(home, "locks"));
  });

  it("per-repo `worktrees_dir` wins over global", async () => {
    await writeFile(
      path.join(home, "config.yaml"),
      `worktrees_dir: /global/wt
`,
    );
    await mkdir(path.join(repo, ".minifac"), { recursive: true });
    await writeFile(
      path.join(repo, ".minifac", "config.yaml"),
      `worktrees_dir: /repo/wt
`,
    );
    const cfg = await loadWorktreeConfig(repo);
    expect(cfg.worktreesDir).toBe("/repo/wt");
  });

  it("ignores per-repo `locks_dir` silently", async () => {
    await writeFile(
      path.join(home, "config.yaml"),
      `locks_dir: /global/locks
`,
    );
    await mkdir(path.join(repo, ".minifac"), { recursive: true });
    await writeFile(
      path.join(repo, ".minifac", "config.yaml"),
      `locks_dir: /repo/locks
`,
    );
    const cfg = await loadWorktreeConfig(repo);
    expect(cfg.locksDir).toBe("/global/locks");
  });

  it("rejects malformed YAML with file path in message", async () => {
    await writeFile(
      path.join(home, "config.yaml"),
      `worktrees_dir: { open
`,
    );
    await expect(loadWorktreeConfig(repo)).rejects.toBeInstanceOf(WorktreeConfigError);
    await expect(loadWorktreeConfig(repo)).rejects.toThrow(/config\.yaml/);
  });

  it("rejects per-repo `default_branch` taking precedence over global", async () => {
    await writeFile(path.join(home, "config.yaml"), `default_branch: main\n`);
    await mkdir(path.join(repo, ".minifac"), { recursive: true });
    await writeFile(
      path.join(repo, ".minifac", "config.yaml"),
      `default_branch: trunk\n`,
    );
    const cfg = await loadWorktreeConfig(repo);
    expect(cfg.defaultBranch).toBe("trunk");
  });
});
