import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// SCARIFW-1304: concurrent PRs each append a bullet to the same `## [Unreleased]`
// block, so git sees two different lines added at the same position and reports a
// textual conflict. The resolution is always "keep both bullets", and the root
// .gitattributes now has git do it by marking CHANGELOG.md `merge=union` — a
// built-in merge driver, so there is no merge.*.driver config and nothing for a
// contributor to install.
//
// These examples execute the behaviour rather than reading the file: they build a
// throwaway git repo in a temp directory seeded with this repo's REAL
// .gitattributes bytes and merge two diverging branches for real.
//
// The guard-deletion example is what makes the positive ones non-vacuous. It runs
// the SAME helper over the SAME scenario with only the `CHANGELOG.md merge=union`
// line stripped out of the seeded attributes body, and asserts the merge then DOES
// conflict — so deleting the line from .gitattributes reds this file.
//
// Unlike smoke.test.ts next door this is deliberately NOT env-gated: it has to run
// by default in CI.
//
// Every git invocation is hermetic — GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and
// GIT_ATTR_NOSYSTEM are neutralised and each temp repo sets its own identity,
// commit.gpgsign=false and a core.hooksPath pointing at the null device, the same
// isolation src/worktree/git.test.ts applies — so no machine-level attributes
// file, merge.conflictstyle or hook can decide either half of the proof.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const attributesPath = path.join(repoRoot, ".gitattributes");

const UNION_LINE = /^\s*CHANGELOG\.md\s+merge=union\s*$/;
const BULLET_A = "- Bullet from branch A (SCARIFW-AAA).";
const BULLET_B = "- Bullet from branch B (SCARIFW-BBB).";
const BASELINE_BULLET = "- Baseline bullet.";

const FIXTURE_CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Fixed",
  "",
  BASELINE_BULLET,
  "",
  "## [0.1.0] - 2026-01-01",
  "",
].join("\n");

// Neutralises every source of git configuration outside the temp repo itself.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

type Operation = "merge" | "rebase";

interface IntegrationResult {
  status: number;
  output: string;
  changelog: string;
  unmerged: string;
}

// Scaffolding: a failure here is a broken test, not a result, so it throws.
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: "pipe" });
}

// The command under test: its exit status is the thing being asserted, so it must
// not throw.
function gitAllowingFailure(cwd: string, ...args: string[]): { status: number; output: string } {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function stripUnionLine(attributesBody: string): string {
  return attributesBody
    .split("\n")
    .filter((line) => !UNION_LINE.test(line))
    .join("\n");
}

// Inserts `bullet` immediately under `### Fixed`. Both branches call this, so they
// write at the identical position — which is what makes the two sides conflict
// without the attribute. Throws if the fixture ever stops matching, rather than
// silently leaving the branches identical (which would make every example pass for
// the wrong reason).
function insertBullet(changelogPath: string, bullet: string): void {
  const contents = readFileSync(changelogPath, "utf8");
  const updated = contents.replace("### Fixed\n\n", `### Fixed\n\n${bullet}\n`);
  if (updated === contents) {
    throw new Error(`fixture CHANGELOG.md did not change when inserting ${bullet}`);
  }
  writeFileSync(changelogPath, updated);
}

function seedFixtureRepo(dir: string, attributesBody: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Union Merge Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", "/dev/null");

  writeFileSync(path.join(dir, ".gitattributes"), attributesBody);
  writeFileSync(path.join(dir, "CHANGELOG.md"), FIXTURE_CHANGELOG);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Seed the fixture repository");
}

// Diverges branch-a and branch-b off main, each appending its own bullet at the
// identical position — the shape every pair of concurrent PRs has.
function divergeBranches(dir: string, changelogPath: string): void {
  git(dir, "checkout", "-q", "-b", "branch-a");
  insertBullet(changelogPath, BULLET_A);
  git(dir, "commit", "-q", "-am", "Add the branch A bullet");

  git(dir, "checkout", "-q", "main");
  git(dir, "checkout", "-q", "-b", "branch-b");
  insertBullet(changelogPath, BULLET_B);
  git(dir, "commit", "-q", "-am", "Add the branch B bullet");
}

// Builds the diverged repo from `attributesBody` and then either merges branch-b
// into branch-a or rebases branch-b onto branch-a. The attributes body is the ONLY
// thing that varies between the positive examples and the guard-deletion example,
// so the two cannot drift apart.
function divergedRepoResult(attributesBody: string, operation: Operation): IntegrationResult {
  const dir = mkdtempSync(path.join(tmpdir(), "changelog-union-merge-"));
  const changelogPath = path.join(dir, "CHANGELOG.md");

  seedFixtureRepo(dir, attributesBody);
  divergeBranches(dir, changelogPath);

  let integration: { status: number; output: string };
  if (operation === "merge") {
    git(dir, "checkout", "-q", "branch-a");
    integration = gitAllowingFailure(dir, "merge", "--no-edit", "branch-b");
  } else {
    integration = gitAllowingFailure(dir, "rebase", "branch-a", "branch-b");
  }

  return {
    status: integration.status,
    output: integration.output,
    changelog: readFileSync(changelogPath, "utf8"),
    unmerged: gitAllowingFailure(dir, "ls-files", "-u").output.trim(),
  };
}

describe("CHANGELOG.md union merge (.gitattributes)", () => {
  it("ships a root .gitattributes whose only functional line is CHANGELOG.md merge=union", () => {
    const functionalLines = readFileSync(attributesPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));

    expect(functionalLines).toHaveLength(1);
    expect(functionalLines[0]).toMatch(UNION_LINE);
  });

  it(
    "merges two branches that each append an [Unreleased] bullet, keeping both",
    { timeout: 30_000 },
    () => {
      const result = divergedRepoResult(readFileSync(attributesPath, "utf8"), "merge");

      expect(result.status, `git merge failed:\n${result.output}`).toBe(0);
      expect(result.changelog).toContain(BULLET_A);
      expect(result.changelog).toContain(BULLET_B);
      expect(result.changelog).toContain(BASELINE_BULLET);
      expect(result.changelog).not.toContain("<<<<<<<");
      expect(result.changelog).not.toContain("=======");
      expect(result.changelog).not.toContain(">>>>>>>");
      expect(result.unmerged).toBe("");
    },
  );

  it(
    "conflicts on the identical scenario once the merge=union line is removed",
    { timeout: 30_000 },
    () => {
      const withoutUnion = stripUnionLine(readFileSync(attributesPath, "utf8"));
      expect(withoutUnion).not.toMatch(/merge=union/);

      const result = divergedRepoResult(withoutUnion, "merge");

      expect(
        result.status,
        `expected a conflict without merge=union:\n${result.changelog}`,
      ).not.toBe(0);
      expect(result.changelog).toContain("<<<<<<<");
    },
  );

  // The factory's revise path rebases rather than merges, and a `needs_rebase`
  // review verdict is resolved by a rebase, so the attribute has to hold there too.
  it(
    "rebases the diverging branch onto the other, keeping both bullets",
    { timeout: 30_000 },
    () => {
      const result = divergedRepoResult(readFileSync(attributesPath, "utf8"), "rebase");

      expect(result.status, `git rebase failed:\n${result.output}`).toBe(0);
      expect(result.changelog).toContain(BULLET_A);
      expect(result.changelog).toContain(BULLET_B);
      expect(result.changelog).not.toContain("<<<<<<<");
      expect(result.changelog).not.toContain("=======");
      expect(result.changelog).not.toContain(">>>>>>>");
    },
  );
});
