import { stat } from "node:fs/promises";
import path from "node:path";
import { type Brief, BriefLoadError, loadBrief } from "../brief/loader.js";

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

async function resolveFactoryByName(name: string, cwd: string): Promise<string> {
  const candidate = path.resolve(cwd, "examples", `${name}.yaml`);
  if (await exists(candidate)) return candidate;
  throw new RunArgResolutionError(`Could not resolve factory \`${name}\` — tried ${candidate}`);
}

/**
 * Resolve a `minifac run <thing>` argument to a brief, a factory, or an error.
 *
 * Precedence (per the run-cli spec):
 *   1. Path-like → brief path.
 *   2. inputs/<thing>.md exists → brief by name.
 *   3. examples/<thing>.yaml exists → factory by name (brief-less).
 *   4. Else → error.
 *
 * In cases 1 and 2, the brief's `factory:` field is further resolved to
 * `examples/<factory>.yaml`; a missing factory is a usage error.
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

  const factoryCandidate = path.resolve(cwd, "examples", `${arg}.yaml`);
  if (await exists(factoryCandidate)) {
    return { kind: "factory", factoryPath: factoryCandidate };
  }

  throw new RunArgResolutionError(
    `Could not resolve \`${arg}\` as a brief path, brief name (${briefCandidate}), or factory name (${factoryCandidate})`,
  );
}

export { BriefLoadError };
