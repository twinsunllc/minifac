import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { installRoot } from "../packaging/install-root.js";
import { StepLoadError } from "../step/loader-error.js";
import { loadStep } from "../step/loader.js";

interface IO {
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
}

export type StepSource = "local" | "built-in";

export interface StepsActionInput {
  source?: string;
  json?: boolean;
  cwd: string;
  io: IO;
  /**
   * Test-only override for the directory scanned as `source: built-in`.
   * Production callers should leave this unset and let the default
   * install-root-first / source-tree-fallback lookup apply.
   */
  builtinDirOverride?: string;
}

interface StepRow {
  name: string;
  version: string | null;
  source: StepSource;
  path: string;
  description: string | null;
  error: string | null;
}

const SOURCES_ALL = new Set<string>(["local", "built-in", "all"]);

async function listYamlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function builtinStepsDir(cwd: string): Promise<string> {
  const fromInstall = path.resolve(installRoot(), "examples", "steps");
  if (await dirExists(fromInstall)) return fromInstall;
  return path.resolve(cwd, "examples", "steps");
}

function termWidth(stdout: IO["stdout"]): number {
  const cols = (stdout as { columns?: number }).columns;
  if (typeof cols === "number" && cols > 0) return cols;
  return 100;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

function truncate(s: string, w: number): string {
  if (s.length <= w) return s;
  if (w <= 1) return s.slice(0, w);
  return `${s.slice(0, Math.max(0, w - 1))}…`;
}

export async function stepsAction(input: StepsActionInput): Promise<number> {
  const sourceFilter = input.source ?? "all";
  if (!SOURCES_ALL.has(sourceFilter)) {
    input.io.stderr.write(
      `Invalid --source \`${sourceFilter}\`. Must be one of: local, built-in, all.\n`,
    );
    return 1;
  }

  const dirs: Array<{ dir: string; source: StepSource }> = [];
  if (sourceFilter === "local" || sourceFilter === "all") {
    dirs.push({ dir: path.resolve(input.cwd, ".minifac", "steps"), source: "local" });
  }
  if (sourceFilter === "built-in" || sourceFilter === "all") {
    const dir = input.builtinDirOverride ?? (await builtinStepsDir(input.cwd));
    dirs.push({ dir, source: "built-in" });
  }

  const rows: StepRow[] = [];
  for (const { dir, source } of dirs) {
    const files = await listYamlFiles(dir);
    for (const fileName of files) {
      const full = path.join(dir, fileName);
      try {
        const { step } = await loadStep(full);
        rows.push({
          name: step.name,
          version: step.version,
          source,
          path: full,
          description: step.description ?? null,
          error: null,
        });
      } catch (err) {
        const message = err instanceof StepLoadError ? err.message : (err as Error).message;
        // Use the file name (sans extension) as the placeholder name.
        const base = fileName.replace(/\.(yaml|yml)$/, "");
        rows.push({
          name: base,
          version: null,
          source,
          path: full,
          description: null,
          error: message,
        });
      }
    }
  }

  rows.sort((a, b) => {
    if (a.source !== b.source) return a.source === "local" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (input.json) {
    input.io.stdout.write(`${JSON.stringify(rows)}\n`);
    return 0;
  }

  if (rows.length === 0) {
    input.io.stdout.write("(no steps)\n");
    return 0;
  }

  const width = termWidth(input.io.stdout);
  const nameW = 24;
  const versionW = 10;
  const sourceW = 10;
  const used = nameW + 2 + versionW + 2 + sourceW + 2;
  const descW = Math.max(10, width - used);

  const lines: string[] = [];
  lines.push(
    `${pad("NAME", nameW)}  ${pad("VERSION", versionW)}  ${pad("SOURCE", sourceW)}  DESCRIPTION`,
  );
  for (const r of rows) {
    const desc = r.error ? `(error) ${r.error}` : (r.description ?? "").replace(/\s+/g, " ").trim();
    lines.push(
      `${pad(r.name, nameW)}  ${pad(r.version ?? "-", versionW)}  ${pad(r.source, sourceW)}  ${truncate(desc, descW)}`,
    );
  }
  input.io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
