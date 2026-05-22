import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { RunStore } from "../storage/run-store.js";
import { minifacHome } from "../worktree/config.js";
import type { Classification, PruneOptions } from "../worktree/prune.js";

export interface OutputsPruneCounts {
  removed: Record<Classification, number>;
  kept: Record<Classification, number>;
  errors: { dir: string; message: string }[];
}

export interface OutputsPruneInput {
  options: PruneOptions;
  store?: RunStore;
  /** Override "now" for deterministic tests. */
  now?: number;
  /** Override stderr for tests; defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
  /** Override the root outputs dir. Defaults to `${MINIFAC_HOME}/outputs`. */
  outputsRoot?: string;
}

function emptyCounts(): OutputsPruneCounts {
  return {
    removed: { fresh: 0, "merged-old": 0, "unmerged-old": 0, failed: 0 },
    kept: { fresh: 0, "merged-old": 0, "unmerged-old": 0, failed: 0 },
    errors: [],
  };
}

function cutoffMillisFromOpts(opts: PruneOptions): number {
  const def = 7 * 24 * 60 * 60 * 1000; // 7 days
  if (!opts.olderThan) return def;
  const { value, unit } = opts.olderThan;
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

function shouldRemove(cls: Classification, opts: PruneOptions): boolean {
  const noSelector = !opts.all && !opts.merged && !opts.failed;
  if (cls === "failed") return opts.failed === true;
  if (cls === "merged-old") return opts.merged === true || opts.all === true || noSelector;
  if (cls === "unmerged-old") return opts.all === true;
  if (cls === "fresh") return opts.all === true;
  return false;
}

/**
 * Prune the per-run outputs tree under `${MINIFAC_HOME}/outputs/`, classifying
 * each `<run-id>` subdirectory by status + age the same way worktrees are
 * classified, and removing the ones the flag matrix selects.
 *
 * Running runs are never eligible regardless of age.
 *
 * For every removed run, the matching rows in `node_outputs` (filtered by
 * `run_id`) are DELETEd from the store. Other run tables are preserved so the
 * run's event log remains queryable after its outputs are reclaimed.
 */
export async function pruneOutputs(input: OutputsPruneInput): Promise<OutputsPruneCounts> {
  const counts = emptyCounts();
  const now = input.now ?? Date.now();
  const stderr = input.stderr ?? process.stderr;
  const root = input.outputsRoot ?? path.join(minifacHome(), "outputs");
  const cutoff = cutoffMillisFromOpts(input.options);

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return counts;
    throw err;
  }

  for (const runId of entries) {
    const dir = path.join(root, runId);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(dir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    // Look up run status. Skip running runs entirely.
    let status: "running" | "succeeded" | "failed" | null = null;
    let merged = false;
    if (input.store) {
      try {
        const row = await input.store.getRun(runId);
        if (row) {
          status = row.status;
        }
      } catch {
        // best effort; treat as unknown
      }
    }
    if (status === "running") {
      // Keep — running runs are never eligible regardless of age.
      continue;
    }
    const ageMs = now - s.mtimeMs;
    let cls: Classification;
    if (ageMs < cutoff) {
      cls = "fresh";
    } else if (status === "failed") {
      cls = "failed";
    } else if (status === "succeeded") {
      // Treat succeeded runs as merged-old for classification purposes —
      // mirroring worktrees where the branch existed and is presumed merged.
      // (We don't have branch-merge info on outputs alone.)
      merged = true;
      cls = "merged-old";
    } else {
      cls = "unmerged-old";
    }
    void merged;
    if (shouldRemove(cls, input.options)) {
      try {
        await rm(dir, { recursive: true, force: true });
        counts.removed[cls] += 1;
        if (input.store?.deleteNodeOutputsForRun) {
          try {
            await input.store.deleteNodeOutputsForRun(runId);
          } catch (err) {
            stderr.write(
              `Warning: failed to delete node_outputs rows for run ${runId}: ${(err as Error).message}\n`,
            );
          }
        }
      } catch (err) {
        counts.errors.push({ dir, message: (err as Error).message });
        counts.kept[cls] += 1;
      }
    } else {
      counts.kept[cls] += 1;
    }
  }

  return counts;
}
