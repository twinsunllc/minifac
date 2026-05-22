import { stat } from "node:fs/promises";
import path from "node:path";
import { type Brief, BriefLoadError, loadBrief } from "../brief/loader.js";
import { BriefCycleError, computeBriefState } from "../brief/state.js";
import { installRoot } from "../packaging/install-root.js";
import type { RunStore } from "../storage/run-store.js";

export type ResolvedRun =
  | { kind: "brief"; brief: Brief; factoryPath: string }
  | { kind: "factory"; factoryPath: string };

export class RunArgResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunArgResolutionError";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

function isPathLike(arg: string): boolean {
  return arg.includes(path.sep) || arg.includes("/") || arg.endsWith(".md");
}

/**
 * Resolve a factory reference to an absolute path.
 *
 * Two forms are accepted:
 *
 *   - `minifac:<name>` — built-in factory; resolved against
 *     `<install-root>/examples/<name>.yaml` first, then
 *     `<cwd>/examples/<name>.yaml`. The local lookup is skipped.
 *   - `<name>` (no prefix) — try `<cwd>/.minifac/factories/<name>.yaml`
 *     first, then fall back to `<cwd>/examples/<name>.yaml`. The install
 *     root is NOT consulted for bare names.
 *
 * On miss, a `RunArgResolutionError` is thrown naming every path tried.
 */
export async function resolveFactoryByName(ref: string, cwd: string): Promise<string> {
  if (ref.startsWith("minifac:")) {
    const name = ref.slice("minifac:".length);
    const installCandidate = path.resolve(installRoot(), "examples", `${name}.yaml`);
    if (await exists(installCandidate)) return installCandidate;
    const localCandidate = path.resolve(cwd, "examples", `${name}.yaml`);
    if (await exists(localCandidate)) return localCandidate;
    throw new RunArgResolutionError(
      `Could not resolve factory \`${ref}\` — tried ${installCandidate}, then ${localCandidate}`,
    );
  }
  const localCandidate = path.resolve(cwd, ".minifac", "factories", `${ref}.yaml`);
  if (await exists(localCandidate)) return localCandidate;
  const exampleCandidate = path.resolve(cwd, "examples", `${ref}.yaml`);
  if (await exists(exampleCandidate)) return exampleCandidate;
  throw new RunArgResolutionError(
    `Could not resolve factory \`${ref}\` — tried ${localCandidate} and ${exampleCandidate}`,
  );
}

/**
 * Resolve a `minifac run <thing>` argument to a brief, a factory, or an error.
 *
 * Precedence (per the run-cli spec):
 *   1. Path-like → brief path.
 *   2. inputs/<thing>.md exists → brief by name.
 *   3. Factory by name. Resolved via the two-step lookup described on
 *      `resolveFactoryByName`: `<thing>` is tried as
 *      `.minifac/factories/<thing>.yaml` first, then `examples/<thing>.yaml`.
 *   4. Else → error.
 *
 * In cases 1 and 2, the brief's `factory:` field is further resolved using
 * the same factory-by-name lookup (and accepts the `minifac:<name>` prefix);
 * a missing factory is a usage error.
 */
export async function resolveRunArg(arg: string, cwd: string): Promise<ResolvedRun> {
  if (isPathLike(arg)) {
    const briefPath = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
    if (!(await exists(briefPath))) {
      throw new RunArgResolutionError(`Brief not found at ${briefPath}`);
    }
    const brief = await loadBrief(briefPath, cwd);
    const factoryPath = await resolveFactoryByName(brief.frontmatter.factory, cwd);
    return { kind: "brief", brief, factoryPath };
  }

  const briefCandidate = path.resolve(cwd, "inputs", `${arg}.md`);
  if (await exists(briefCandidate)) {
    const brief = await loadBrief(arg, cwd);
    const factoryPath = await resolveFactoryByName(brief.frontmatter.factory, cwd);
    return { kind: "brief", brief, factoryPath };
  }

  // Factory by name — uses the same two-step lookup as the brief's
  // `factory:` field. Don't accept the `minifac:` prefix at the CLI arg
  // level (the prefix lives on the brief's `factory:` for durability); but
  // the bare name does fall through to local-then-built-in.
  try {
    const factoryPath = await resolveFactoryByName(arg, cwd);
    return { kind: "factory", factoryPath };
  } catch {
    // Fall through to the unified error.
  }

  const localCandidate = path.resolve(cwd, ".minifac", "factories", `${arg}.yaml`);
  const exampleCandidate = path.resolve(cwd, "examples", `${arg}.yaml`);
  throw new RunArgResolutionError(
    `Could not resolve \`${arg}\` as a brief path, brief name (${briefCandidate}), or factory name (${localCandidate}, ${exampleCandidate})`,
  );
}

export { BriefLoadError };

export type BriefDepsGateOutcome =
  | { kind: "proceed" }
  | { kind: "warn"; message: string }
  | { kind: "refuse"; message: string };

export interface BriefDepsGateInput {
  brief: Brief;
  runStore: RunStore;
  cwd: string;
  force?: boolean;
}

/**
 * Evaluate brief deps before lockfile claim / worktree creation. Returns
 * an outcome the caller renders to stderr / exits on. Cycle errors are
 * propagated as-is and SHALL NOT be bypassed by `--force`.
 */
export async function gateBriefDeps(input: BriefDepsGateInput): Promise<BriefDepsGateOutcome> {
  const inputsDir = path.resolve(input.cwd, "inputs");
  const rootChange = input.brief.frontmatter.change;
  // Caller has already loaded the root brief; reuse it so the gate does
  // not re-resolve `<inputsDir>/<change>.md` (which may not match when
  // the file name and the frontmatter `change:` differ).
  const state = await computeBriefState(rootChange, {
    inputsDir,
    repoRoot: input.cwd,
    runStore: input.runStore,
    loadBrief: async (c: string) => {
      if (c === rootChange) return input.brief;
      const { loadBrief } = await import("../brief/loader.js");
      return loadBrief(c, input.cwd);
    },
  });
  if (!state.blocked) return { kind: "proceed" };
  const summary = state.deps
    .filter((d) => d.doneness !== "done")
    .map((d) => `  - ${d.change} (${d.doneness})`)
    .join("\n");
  const reason = state.blockedReason ?? "unsatisfied deps";
  if (input.force) {
    return {
      kind: "warn",
      message: `Warning: --force overriding unsatisfied deps for \`${input.brief.frontmatter.change}\`: ${reason}\n${summary}`,
    };
  }
  return {
    kind: "refuse",
    message: `Refusing to run \`${input.brief.frontmatter.change}\`: blocked by unsatisfied deps:\n${summary}\nPass --force to override.`,
  };
}

export { BriefCycleError };
