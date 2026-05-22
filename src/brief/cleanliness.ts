// Brief cleanliness probe — see docs/decisions/0033-Brief-Cleanliness-Gate.md
// and openspec/specs/brief-cleanliness/spec.md.
//
// `checkBriefCleanliness` shells out to `git status --porcelain` for a
// single brief file and classifies it as clean / unclean / disabled.
// `checkBriefAndAncestorsCleanliness` walks the brief's `depends_on`
// graph depth-first and surfaces the first unclean brief.

import { type GitResult, runGit } from "../worktree/git.js";
import type { Brief } from "./loader.js";
import { BriefCycleError } from "./state.js";

export type CleanlinessResult =
  | { status: "clean" }
  | { status: "unclean"; code: string }
  | { status: "disabled"; reason: "not-a-git-repo" };

export type AncestorCleanlinessResult =
  | { status: "clean" }
  | { status: "disabled" }
  | { status: "unclean"; offending: string; code: string };

/** Injectable git runner for tests. Defaults to the real `git` subprocess. */
export type GitStatusRunner = (repoRoot: string, briefPath: string) => Promise<GitResult>;

const defaultRunner: GitStatusRunner = (repoRoot, briefPath) =>
  runGit(repoRoot, ["status", "--porcelain", "--", briefPath]);

function isNotARepoStderr(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

export async function checkBriefCleanliness(
  briefPath: string,
  repoRoot: string,
  runner: GitStatusRunner = defaultRunner,
): Promise<CleanlinessResult> {
  const res = await runner(repoRoot, briefPath);
  if (res.exitCode === 0) {
    if (res.stdout.length === 0) return { status: "clean" };
    const firstLine = res.stdout.split(/\r?\n/)[0] ?? "";
    if (firstLine.length === 0) return { status: "clean" };
    // Porcelain v1 prefix is exactly two characters (XY).
    const code = firstLine.slice(0, 2);
    return { status: "unclean", code };
  }
  if (isNotARepoStderr(res.stderr)) {
    return { status: "disabled", reason: "not-a-git-repo" };
  }
  throw new Error(
    `git status --porcelain failed (exit ${res.exitCode}): ${res.stderr.trim() || "(no stderr)"}`,
  );
}

export interface AncestorCleanlinessOpts {
  inputsDir: string;
  repoRoot: string;
  loadBrief: (change: string) => Promise<Brief>;
  /** Inject a runner for tests. */
  runner?: GitStatusRunner;
}

function getDeclaredDeps(brief: Brief): string[] {
  const fm = brief.frontmatter as { depends_on?: unknown };
  const raw = fm.depends_on;
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  return [];
}

interface WalkContext {
  repoRoot: string;
  loadBrief: (change: string) => Promise<Brief>;
  runner: GitStatusRunner;
  /** Cycle-detection path (current DFS stack). */
  stack: string[];
  /** Visited briefs whose subtree has been fully probed clean. */
  visitedClean: Set<string>;
  /** Set when the underlying probe returned `disabled`. */
  disabled: boolean;
}

type WalkOutcome =
  | { kind: "clean" }
  | { kind: "disabled" }
  | { kind: "unclean"; offending: string; code: string };

async function walk(change: string, brief: Brief, ctx: WalkContext): Promise<WalkOutcome> {
  if (ctx.disabled) return { kind: "disabled" };
  const result = await checkBriefCleanliness(brief.sourcePath, ctx.repoRoot, ctx.runner);
  if (result.status === "disabled") {
    ctx.disabled = true;
    return { kind: "disabled" };
  }
  if (result.status === "unclean") {
    return { kind: "unclean", offending: change, code: result.code };
  }
  ctx.visitedClean.add(change);
  const deps = getDeclaredDeps(brief);
  for (const dep of deps) {
    if (ctx.stack.includes(dep)) {
      throw new BriefCycleError([...ctx.stack, dep]);
    }
    if (ctx.visitedClean.has(dep)) continue;
    // Resolve to a real file; sentinels (no matching file) are skipped.
    let depBrief: Brief;
    try {
      depBrief = await ctx.loadBrief(dep);
    } catch {
      continue;
    }
    ctx.stack.push(dep);
    try {
      const sub = await walk(dep, depBrief, ctx);
      if (sub.kind !== "clean") return sub;
    } finally {
      ctx.stack.pop();
    }
  }
  return { kind: "clean" };
}

export async function checkBriefAndAncestorsCleanliness(
  rootBrief: Brief,
  opts: AncestorCleanlinessOpts,
): Promise<AncestorCleanlinessResult> {
  const runner = opts.runner ?? defaultRunner;
  const rootChange = rootBrief.frontmatter.change;
  const ctx: WalkContext = {
    repoRoot: opts.repoRoot,
    loadBrief: opts.loadBrief,
    runner,
    stack: [rootChange],
    visitedClean: new Set<string>(),
    disabled: false,
  };
  const out = await walk(rootChange, rootBrief, ctx);
  if (out.kind === "clean") return { status: "clean" };
  if (out.kind === "disabled") return { status: "disabled" };
  return { status: "unclean", offending: out.offending, code: out.code };
}
