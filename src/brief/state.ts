import type { RunStore } from "../storage/run-store.js";
import { type Activity, computeBriefActivity } from "./activity.js";
import { type Doneness, computeBriefDoneness } from "./doneness.js";
import { type Brief, loadBrief as defaultLoadBrief } from "./loader.js";

export class BriefCycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}`);
    this.name = "BriefCycleError";
    this.cycle = cycle;
  }
}

export interface DepResolution {
  change: string;
  doneness: Doneness;
}

export interface BriefStateResolution {
  doneness: Doneness;
  activity: Activity;
  deps: DepResolution[];
  blocked: boolean;
  blockedReason?: string;
  mostRecentRunId?: string;
  branchName?: string;
  endedAt?: number;
}

export interface ComputeBriefStateOpts {
  inputsDir: string;
  repoRoot: string;
  runStore: RunStore;
  loadBrief?: (change: string) => Promise<Brief>;
}

async function tryLoad(change: string, opts: ComputeBriefStateOpts): Promise<Brief | null> {
  if (opts.loadBrief) {
    try {
      return await opts.loadBrief(change);
    } catch {
      return null;
    }
  }
  // Default loader: find the brief at its actual location (active or
  // done) via doneness, then load by absolute path.
  const dn = computeBriefDoneness(change, {
    inputsDir: opts.inputsDir,
    repoRoot: opts.repoRoot,
  });
  if (!dn.filePath) return null;
  try {
    return await defaultLoadBrief(dn.filePath, opts.repoRoot);
  } catch {
    return null;
  }
}

function getDeclaredDeps(brief: Brief | null): string[] {
  if (!brief) return [];
  const fm = brief.frontmatter as { depends_on?: unknown };
  const raw = fm.depends_on;
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  return [];
}

async function walkForCycles(
  root: string,
  opts: ComputeBriefStateOpts,
  path: string[],
  visitedDone: Set<string>,
): Promise<void> {
  if (path.includes(root)) {
    throw new BriefCycleError([...path, root]);
  }
  if (visitedDone.has(root)) return;
  const brief = await tryLoad(root, opts);
  const deps = getDeclaredDeps(brief);
  const nextPath = [...path, root];
  for (const dep of deps) {
    await walkForCycles(dep, opts, nextPath, visitedDone);
  }
  visitedDone.add(root);
}

export async function computeBriefState(
  change: string,
  opts: ComputeBriefStateOpts,
): Promise<BriefStateResolution> {
  // Cycle detection across the entire reachable graph. Detects cycles
  // regardless of doneness so a cycle through a done brief still trips.
  await walkForCycles(change, opts, [], new Set<string>());

  const rootBrief = await tryLoad(change, opts);
  const rootDoneness = computeBriefDoneness(change, {
    inputsDir: opts.inputsDir,
    repoRoot: opts.repoRoot,
  }).doneness;

  if (!rootBrief) {
    return {
      doneness: rootDoneness,
      activity: "none",
      deps: [],
      blocked: true,
      blockedReason: "brief file not found",
    };
  }

  const declared = getDeclaredDeps(rootBrief);
  const deps: DepResolution[] = declared.map((d) => ({
    change: d,
    doneness: computeBriefDoneness(d, {
      inputsDir: opts.inputsDir,
      repoRoot: opts.repoRoot,
    }).doneness,
  }));

  const activity = await computeBriefActivity(change, { runStore: opts.runStore });

  const unsatisfied = deps.filter((d) => d.doneness !== "done");
  const blocked = unsatisfied.length > 0;
  const result: BriefStateResolution = {
    doneness: rootDoneness,
    activity: activity.activity,
    deps,
    blocked,
  };
  if (activity.mostRecentRunId !== undefined) {
    result.mostRecentRunId = activity.mostRecentRunId;
  }
  if (activity.branchName !== undefined) {
    result.branchName = activity.branchName;
  }
  if (activity.endedAt !== undefined) {
    result.endedAt = activity.endedAt;
  }
  if (blocked) {
    result.blockedReason = unsatisfied.map((d) => `${d.change} (${d.doneness})`).join(", ");
  }
  return result;
}
