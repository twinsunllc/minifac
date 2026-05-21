import type { RunStore } from "../storage/run-store.js";

export type Activity = "none" | "running" | "succeeded" | "failed";

export interface ComputeBriefActivityOpts {
  runStore: RunStore;
}

export interface BriefActivityResult {
  activity: Activity;
  mostRecentRunId?: string;
  branchName?: string;
  endedAt?: number;
}

export async function computeBriefActivity(
  change: string,
  opts: ComputeBriefActivityOpts,
): Promise<BriefActivityResult> {
  const rows = await opts.runStore.listRuns({ change, limit: 1 });
  const row = rows[0];
  if (!row) {
    return { activity: "none" };
  }
  const result: BriefActivityResult = {
    activity: row.status,
    mostRecentRunId: row.id,
  };
  if (row.branchName !== null && row.branchName !== undefined) {
    result.branchName = row.branchName;
  }
  if (row.endedAt !== null && row.endedAt !== undefined) {
    result.endedAt = row.endedAt;
  }
  return result;
}
