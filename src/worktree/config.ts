import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";

export interface WorktreeConfig {
  worktreesDir: string;
  locksDir: string;
  defaultBranch?: string;
}

export class WorktreeConfigError extends Error {
  constructor(
    message: string,
    readonly sourcePath: string,
    readonly location?: { line: number; col?: number },
  ) {
    super(message);
    this.name = "WorktreeConfigError";
  }
}

/**
 * Resolve the minifac state root. `MINIFAC_HOME` overrides `~/.minifac`
 * (so tests can redirect state to a tmp dir without touching the real
 * `~/.minifac/`).
 */
export function minifacHome(): string {
  const override = process.env.MINIFAC_HOME;
  if (override && override.length > 0) return override;
  return path.join(homedir(), ".minifac");
}

interface RawConfig {
  worktrees_dir?: unknown;
  locks_dir?: unknown;
  default_branch?: unknown;
}

async function readMaybeYaml(
  filePath: string,
): Promise<{ data: RawConfig; present: true } | { present: false }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { present: false };
    throw new WorktreeConfigError(
      `Could not read minifac config: ${(err as Error).message}`,
      filePath,
    );
  }
  const doc = parseDocument(raw, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    if (!e) throw new WorktreeConfigError("YAML parse error in minifac config", filePath);
    const linePos = e.linePos?.[0];
    throw new WorktreeConfigError(
      `YAML parse error in minifac config at ${filePath}: ${e.message}`,
      filePath,
      linePos ? { line: linePos.line, col: linePos.col } : undefined,
    );
  }
  const data = (doc.toJS() ?? {}) as RawConfig;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new WorktreeConfigError(
      "minifac config must be a YAML mapping at the top level",
      filePath,
    );
  }
  return { data, present: true };
}

function pickString(value: unknown, field: string, sourcePath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new WorktreeConfigError(`Field \`${field}\` must be a non-empty string`, sourcePath);
  }
  return value;
}

/**
 * Load the merged worktree config for a run originating in `callerRepoRoot`.
 *
 * Reads `~/.minifac/config.yaml` (global) and `<repoRoot>/.minifac/config.yaml`
 * (per-repo). Missing files are not errors. When both files set the same key,
 * the per-repo file wins for `worktrees_dir` and `default_branch`.
 * `locks_dir` in the per-repo file is silently ignored — locks are
 * machine-state, not repo-state.
 */
export async function loadWorktreeConfig(callerRepoRoot: string): Promise<WorktreeConfig> {
  const home = minifacHome();
  const globalPath = path.join(home, "config.yaml");
  const repoPath = path.join(callerRepoRoot, ".minifac", "config.yaml");

  const globalLoaded = await readMaybeYaml(globalPath);
  const repoLoaded = await readMaybeYaml(repoPath);

  const defaults: WorktreeConfig = {
    worktreesDir: path.join(home, "worktrees"),
    locksDir: path.join(home, "locks"),
  };

  const cfg: WorktreeConfig = { ...defaults };

  if (globalLoaded.present) {
    const wt = pickString(globalLoaded.data.worktrees_dir, "worktrees_dir", globalPath);
    const lk = pickString(globalLoaded.data.locks_dir, "locks_dir", globalPath);
    const db = pickString(globalLoaded.data.default_branch, "default_branch", globalPath);
    if (wt) cfg.worktreesDir = wt;
    if (lk) cfg.locksDir = lk;
    if (db) cfg.defaultBranch = db;
  }
  if (repoLoaded.present) {
    const wt = pickString(repoLoaded.data.worktrees_dir, "worktrees_dir", repoPath);
    const db = pickString(repoLoaded.data.default_branch, "default_branch", repoPath);
    // locks_dir intentionally NOT honored from per-repo config; validate type
    // if present so a typo error still surfaces.
    pickString(repoLoaded.data.locks_dir, "locks_dir", repoPath);
    if (wt) cfg.worktreesDir = wt;
    if (db) cfg.defaultBranch = db;
  }

  return cfg;
}
