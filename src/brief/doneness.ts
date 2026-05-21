import { existsSync } from "node:fs";
import path from "node:path";

export type Doneness = "active" | "done" | "missing";

export interface ComputeBriefDonenessOpts {
  inputsDir: string;
  repoRoot: string;
}

export interface BriefDonenessResult {
  doneness: Doneness;
  filePath?: string;
}

export function computeBriefDoneness(
  change: string,
  opts: ComputeBriefDonenessOpts,
): BriefDonenessResult {
  const activePath = path.resolve(opts.inputsDir, `${change}.md`);
  if (existsSync(activePath)) {
    return { doneness: "active", filePath: activePath };
  }
  const donePath = path.resolve(opts.inputsDir, "done", `${change}.md`);
  if (existsSync(donePath)) {
    return { doneness: "done", filePath: donePath };
  }
  return { doneness: "missing" };
}
