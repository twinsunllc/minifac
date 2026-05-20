import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { minifacHome } from "./config.js";

export interface FailedRunEntry {
  worktreeDir: string;
  status: string;
  endedAt: string;
  reason?: string;
}

const MAX_ENTRIES = 1000;

function journalPath(): string {
  return path.join(minifacHome(), "failed-runs.json");
}

let warnedOnce = false;
function warnOnce(message: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  process.stderr.write(`[minifac] ${message}\n`);
}

export async function readFailedRuns(): Promise<FailedRunEntry[]> {
  let raw: string;
  try {
    raw = await readFile(journalPath(), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    warnOnce(`failed-runs.json unreadable: ${(err as Error).message}`);
    return [];
  }
  try {
    const data = JSON.parse(raw) as { entries?: unknown };
    if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
      warnOnce("failed-runs.json is malformed; treating as empty");
      return [];
    }
    return data.entries as FailedRunEntry[];
  } catch {
    warnOnce("failed-runs.json is not valid JSON; treating as empty");
    return [];
  }
}

export async function appendFailedRun(entry: FailedRunEntry): Promise<void> {
  const existing = await readFailedRuns();
  const next = [...existing, entry];
  const trimmed = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
  const p = journalPath();
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ entries: trimmed }, null, 2), "utf8");
}
