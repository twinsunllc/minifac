import { readdir } from "node:fs/promises";
import path from "node:path";
import { type Activity, computeBriefActivity } from "../brief/activity.js";
import { type Doneness, computeBriefDoneness } from "../brief/doneness.js";
import { type Brief, loadBrief } from "../brief/loader.js";
import type { RunStore } from "../storage/run-store.js";

interface IO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface BriefsActionInput {
  state?: string;
  activity?: string;
  ready?: boolean;
  inputs?: string;
  json?: boolean;
  store: RunStore;
  cwd: string;
  io: IO;
}

interface BriefRow {
  change: string;
  state: Doneness;
  activity: Activity | "parse_error";
  deps: Array<{ change: string; doneness: Doneness }>;
  deps_summary: string;
  last_run: { id: string; branch: string | null; ended_at: number | null } | null;
}

const STATE_VALUES: Doneness[] = ["active", "done", "missing"];
const ACTIVITY_VALUES: Activity[] = ["none", "running", "succeeded", "failed"];

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3));
  } catch {
    return [];
  }
}

function depsSummary(deps: BriefRow["deps"]): string {
  if (deps.length === 0) return "—";
  const done = deps.filter((d) => d.doneness === "done").length;
  return `${done}/${deps.length} done`;
}

function formatLastRun(last: BriefRow["last_run"]): string {
  if (!last) return "—";
  const idPrefix = last.id.slice(0, 8);
  const branch = last.branch ?? "-";
  const ended = last.ended_at !== null ? new Date(last.ended_at).toISOString() : "-";
  return `${idPrefix} ${branch} ${ended}`;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

export async function briefsAction(input: BriefsActionInput): Promise<number> {
  if (input.state !== undefined && !STATE_VALUES.includes(input.state as Doneness)) {
    input.io.stderr.write(
      `Invalid --state \`${input.state}\`. Must be one of: ${STATE_VALUES.join(", ")}.\n`,
    );
    return 1;
  }
  if (input.activity !== undefined && !ACTIVITY_VALUES.includes(input.activity as Activity)) {
    input.io.stderr.write(
      `Invalid --activity \`${input.activity}\`. Must be one of: ${ACTIVITY_VALUES.join(", ")}.\n`,
    );
    return 1;
  }

  const inputsDir = input.inputs
    ? path.isAbsolute(input.inputs)
      ? input.inputs
      : path.resolve(input.cwd, input.inputs)
    : path.resolve(input.cwd, "inputs");
  const doneDir = path.join(inputsDir, "done");

  const activeNames = await listMdFiles(inputsDir);
  const doneNames = await listMdFiles(doneDir);

  const seen = new Set<string>();
  const all: Array<{ name: string; loc: Doneness }> = [];
  for (const n of activeNames) {
    if (seen.has(n)) continue;
    seen.add(n);
    all.push({ name: n, loc: "active" });
  }
  for (const n of doneNames) {
    if (seen.has(n)) continue;
    seen.add(n);
    all.push({ name: n, loc: "done" });
  }

  const rows: BriefRow[] = [];
  for (const item of all) {
    let brief: Brief | null = null;
    let parseError = false;
    const filePath =
      item.loc === "active"
        ? path.join(inputsDir, `${item.name}.md`)
        : path.join(doneDir, `${item.name}.md`);
    try {
      brief = await loadBrief(filePath, input.cwd);
    } catch {
      parseError = true;
    }

    let deps: BriefRow["deps"] = [];
    if (brief) {
      const declared = brief.frontmatter as { depends_on?: unknown };
      const raw = Array.isArray(declared.depends_on) ? declared.depends_on : [];
      deps = raw
        .filter((d): d is string => typeof d === "string" && d.length > 0)
        .map((d) => ({
          change: d,
          doneness: computeBriefDoneness(d, { inputsDir, repoRoot: input.cwd }).doneness,
        }));
    }

    const activity = parseError
      ? { activity: "parse_error" as const }
      : await computeBriefActivity(item.name, { runStore: input.store });

    rows.push({
      change: item.name,
      state: item.loc,
      activity: activity.activity,
      deps,
      deps_summary: depsSummary(deps),
      last_run:
        !parseError && "mostRecentRunId" in activity && activity.mostRecentRunId
          ? {
              id: activity.mostRecentRunId,
              branch: activity.branchName ?? null,
              ended_at: activity.endedAt ?? null,
            }
          : null,
    });
  }

  rows.sort((a, b) => a.change.localeCompare(b.change));

  let filtered = rows;
  if (input.state) filtered = filtered.filter((r) => r.state === input.state);
  if (input.activity) filtered = filtered.filter((r) => r.activity === input.activity);
  if (input.ready) {
    filtered = filtered.filter(
      (r) =>
        r.state === "active" &&
        r.deps.every((d) => d.doneness === "done") &&
        (r.activity === "none" || r.activity === "failed"),
    );
  }

  if (input.json) {
    input.io.stdout.write(`${JSON.stringify(filtered)}\n`);
    return 0;
  }

  if (filtered.length === 0) {
    input.io.stdout.write("(no briefs)\n");
    return 0;
  }
  const lines: string[] = [];
  lines.push(
    `${pad("CHANGE", 28)}  ${pad("STATE", 8)}  ${pad("ACTIVITY", 12)}  ${pad("DEPS", 12)}  LAST_RUN`,
  );
  for (const r of filtered) {
    lines.push(
      `${pad(r.change, 28)}  ${pad(r.state, 8)}  ${pad(r.activity, 12)}  ${pad(r.deps_summary, 12)}  ${formatLastRun(r.last_run)}`,
    );
  }
  input.io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
