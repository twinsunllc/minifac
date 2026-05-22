import { createReadStream, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { listDirectoryFiles } from "../runner/outputs.js";
import type {
  ListRunsFilter,
  NodeOutputRow,
  RunStatus,
  RunStore,
  StoredEvent,
  StoredRun,
} from "../storage/run-store.js";

interface IO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface ListActionInput {
  factory?: string;
  change?: string;
  status?: string;
  limit?: string;
  json?: boolean;
  store: RunStore;
  io: IO;
}

export async function listAction(input: ListActionInput): Promise<number> {
  const filter: ListRunsFilter = {};
  if (input.factory) filter.factoryName = input.factory;
  if (input.change) filter.change = input.change;
  if (input.status) {
    if (input.status !== "running" && input.status !== "succeeded" && input.status !== "failed") {
      input.io.stderr.write(
        `Invalid --status \`${input.status}\`. Must be one of: running, succeeded, failed.\n`,
      );
      return 1;
    }
    filter.status = input.status as RunStatus;
  }
  let limit = 20;
  if (input.limit !== undefined) {
    const n = Number.parseInt(input.limit, 10);
    if (!Number.isFinite(n) || String(n) !== input.limit.trim() || n <= 0) {
      input.io.stderr.write(`Invalid --limit \`${input.limit}\`. Must be a positive integer.\n`);
      return 1;
    }
    limit = n;
  }
  filter.limit = limit;

  const rows = await input.store.listRuns(filter);

  if (input.json) {
    const out = rows.map((r) => ({
      id: r.id,
      factoryName: r.factoryName,
      change: r.change,
      branchName: r.branchName,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    }));
    input.io.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }

  if (rows.length === 0) {
    input.io.stdout.write("(no runs)\n");
    return 0;
  }

  const lines: string[] = [];
  lines.push(
    "ID        CHANGE/FACTORY              STATUS     STARTED                  BRANCH                          DURATION",
  );
  for (const r of rows) {
    const idPrefix = r.id.slice(0, 8);
    const label = r.change ?? r.factoryName;
    const started = new Date(r.startedAt).toISOString();
    const branch = r.branchName ?? "-";
    const duration = r.endedAt !== null ? `${r.endedAt - r.startedAt}ms` : "—";
    lines.push(
      `${idPrefix}  ${pad(label, 28)}  ${pad(r.status, 9)}  ${pad(started, 24)} ${pad(branch, 32)} ${duration}`,
    );
  }
  input.io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

export interface ShowActionInput {
  idOrPrefix: string;
  follow?: boolean;
  json?: boolean;
  outputs?: boolean;
  store: RunStore;
  io: IO;
  /** Override the poll delay used by --follow (tests). */
  pollMs?: number;
  /** Optional max polls (tests, in case the test runner forgets to finalize). */
  maxPolls?: number;
}

export async function showAction(input: ShowActionInput): Promise<number> {
  const resolved = await resolveRunId(input.idOrPrefix, input.store);
  if (!resolved.ok) {
    input.io.stderr.write(`${resolved.message}\n`);
    return 1;
  }
  const runId = resolved.id;

  let lastSeq = -1;
  let stored = await input.store.getRun(runId);
  if (!stored) {
    input.io.stderr.write(`Run \`${runId}\` not found.\n`);
    return 1;
  }

  // Initial drain.
  const initial = await input.store.getRunEvents(runId);
  for (const e of initial) {
    renderEvent(e, stored, input);
    if (e.seq > lastSeq) lastSeq = e.seq;
  }

  if (!input.follow || stored.status !== "running") {
    if (stored.status !== "running" && !initial.some((e) => e.kind === "run_end")) {
      renderTerminalSummary(stored, input);
    }
    if (input.outputs) {
      await renderOutputs(runId, input);
    }
    return 0;
  }

  // --follow on a still-running run: poll until terminal.
  const pollMs = input.pollMs ?? 250;
  const maxPolls = input.maxPolls ?? 600; // 150s default ceiling
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const events = await input.store.getRunEvents(runId, { sinceSeq: lastSeq });
    for (const e of events) {
      renderEvent(e, stored, input);
      if (e.seq > lastSeq) lastSeq = e.seq;
    }
    const cur = await input.store.getRun(runId);
    if (cur) stored = cur;
    if (stored.status !== "running") {
      if (!events.some((e) => e.kind === "run_end")) {
        renderTerminalSummary(stored, input);
      }
      if (input.outputs) {
        await renderOutputs(runId, input);
      }
      return 0;
    }
  }
  input.io.stderr.write("Stopped following: poll cap reached.\n");
  return 0;
}

async function renderOutputs(runId: string, input: ShowActionInput): Promise<void> {
  const rows = await input.store.getNodeOutputs(runId);
  if (input.json) {
    input.io.stdout.write(`${JSON.stringify({ type: "outputs", rows })}\n`);
    return;
  }
  if (rows.length === 0) {
    input.io.stdout.write(`Outputs for run ${runId}:\n  (none)\n`);
    return;
  }
  const lines: string[] = [`Outputs for run ${runId}:`];
  let lastGroup = "";
  for (const r of rows) {
    const groupKey = `${r.nodeId}|${r.iteration}`;
    if (groupKey !== lastGroup) {
      lines.push(`  ${r.nodeId} (iter ${r.iteration}):`);
      lastGroup = groupKey;
    }
    lines.push(`    ${r.outputKey} (${formatOutputDetail(r)})`);
  }
  input.io.stdout.write(`${lines.join("\n")}\n`);
}

function formatOutputDetail(r: NodeOutputRow): string {
  if (r.outputType === "directory") {
    let fileCount = 0;
    try {
      const files = listDirectoryFilesSyncBest(r.path);
      fileCount = files;
    } catch {
      fileCount = 0;
    }
    return `directory, ${fileCount} file${fileCount === 1 ? "" : "s"}, ${formatBytes(r.size)}`;
  }
  return `${r.outputType}, ${formatBytes(r.size)}`;
}

function listDirectoryFilesSyncBest(dir: string): number {
  // Cheap fast count for the --outputs tree. We don't need recursive walk
  // accuracy here — we just want "is this directory non-empty and roughly
  // how many files." Reuse the validator's walk if we have it.
  try {
    // statSync detects existence; we use a sync readdir if we can find it.
    const s = statSync(dir);
    if (!s.isDirectory()) return 0;
  } catch {
    return 0;
  }
  let count = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(cur, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) count += 1;
    }
  }
  return count;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

interface ResolvedOk {
  ok: true;
  id: string;
}
interface ResolvedErr {
  ok: false;
  message: string;
}

async function resolveRunId(
  idOrPrefix: string,
  store: RunStore,
): Promise<ResolvedOk | ResolvedErr> {
  if (idOrPrefix.length === 0) {
    return { ok: false, message: "Run id is required." };
  }
  const exact = await store.getRun(idOrPrefix);
  if (exact) return { ok: true, id: exact.id };

  const candidates = await store.listRuns({ limit: 500 });
  const matches = candidates.filter((r) => r.id.startsWith(idOrPrefix));
  if (matches.length === 0) {
    return { ok: false, message: `No run matches \`${idOrPrefix}\`.` };
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id).join(", ");
    return {
      ok: false,
      message: `Prefix \`${idOrPrefix}\` is ambiguous; matches: ${ids}`,
    };
  }
  return { ok: true, id: (matches[0] as StoredRun).id };
}

function renderEvent(e: StoredEvent, stored: StoredRun, input: ShowActionInput): void {
  if (input.json) {
    input.io.stdout.write(`${JSON.stringify(e)}\n`);
    return;
  }
  if (e.kind === "run_end") {
    renderTerminalSummary(stored, input);
    return;
  }
  const payload = e.payload as { line?: string; status?: string } | null;
  if (e.kind === "stdout") {
    input.io.stdout.write(`[${e.nodeId}] ${payload?.line ?? ""}\n`);
    return;
  }
  if (e.kind === "stderr") {
    input.io.stderr.write(`[${e.nodeId}] ${payload?.line ?? ""}\n`);
    return;
  }
  if (e.kind === "status") {
    input.io.stderr.write(
      `[status] ${e.nodeId ?? "?"} iter=${e.iteration}: ${payload?.status ?? "?"}\n`,
    );
  }
}

function renderTerminalSummary(stored: StoredRun, input: ShowActionInput): void {
  if (input.json) return;
  const tail = stored.reason ? ` (${stored.reason})` : "";
  input.io.stderr.write(`[run] ${stored.status}${tail}\n`);
}

export interface CatActionInput {
  idOrPrefix: string;
  selector: string;
  store: RunStore;
  io: IO;
}

interface ParsedSelector {
  nodeId: string;
  iteration?: number;
  outputKey: string;
  filename?: string;
}

export function parseSelector(selector: string): ParsedSelector | { error: string } {
  // Grammar: <node-id>[:<iteration>]/<output-key>[/<filename>]
  const slash = selector.indexOf("/");
  if (slash === -1) {
    return {
      error: `selector must contain '/': expected <node-id>[:<iteration>]/<output-key>[/<filename>]`,
    };
  }
  const nodePart = selector.slice(0, slash);
  const rest = selector.slice(slash + 1);
  if (nodePart.length === 0 || rest.length === 0) {
    return { error: "selector parts must be non-empty" };
  }
  let nodeId = nodePart;
  let iteration: number | undefined;
  const colon = nodePart.indexOf(":");
  if (colon !== -1) {
    nodeId = nodePart.slice(0, colon);
    const iterStr = nodePart.slice(colon + 1);
    const n = Number.parseInt(iterStr, 10);
    if (!Number.isFinite(n) || String(n) !== iterStr || n <= 0) {
      return { error: `invalid iteration \`${iterStr}\`; must be a positive integer` };
    }
    iteration = n;
  }
  // Validate node id grammar to match the runner's regex.
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(nodeId)) {
    return { error: `invalid node id \`${nodeId}\`` };
  }
  // Split rest into outputKey [/ filename]
  const slash2 = rest.indexOf("/");
  let outputKey: string;
  let filename: string | undefined;
  if (slash2 === -1) {
    outputKey = rest;
  } else {
    outputKey = rest.slice(0, slash2);
    filename = rest.slice(slash2 + 1);
    if (filename.length === 0) {
      return { error: "filename must be non-empty when a trailing slash is present" };
    }
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(outputKey)) {
    return { error: `invalid output key \`${outputKey}\`` };
  }
  const parsed: ParsedSelector = { nodeId, outputKey };
  if (iteration !== undefined) parsed.iteration = iteration;
  if (filename !== undefined) parsed.filename = filename;
  return parsed;
}

export async function catAction(input: CatActionInput): Promise<number> {
  const parsed = parseSelector(input.selector);
  if ("error" in parsed) {
    input.io.stderr.write(`Usage error: ${parsed.error}\n`);
    return 1;
  }
  const resolved = await resolveRunId(input.idOrPrefix, input.store);
  if (!resolved.ok) {
    input.io.stderr.write(`${resolved.message}\n`);
    return 1;
  }
  const runId = resolved.id;
  const filter: { nodeId: string; iteration?: number } = { nodeId: parsed.nodeId };
  if (parsed.iteration !== undefined) filter.iteration = parsed.iteration;
  const rows = await input.store.getNodeOutputs(runId, filter);
  if (rows.length === 0) {
    if (parsed.iteration !== undefined) {
      input.io.stderr.write(
        `No output \`${parsed.outputKey}\` for node \`${parsed.nodeId}\` iteration ${parsed.iteration} in run \`${runId}\`.\n`,
      );
    } else {
      input.io.stderr.write(
        `No outputs recorded for node \`${parsed.nodeId}\` in run \`${runId}\`.\n`,
      );
    }
    return 1;
  }
  // Find candidates for the output key. If iteration not specified, pick the
  // latest iteration that has the key.
  const matches = rows.filter((r) => r.outputKey === parsed.outputKey);
  if (matches.length === 0) {
    input.io.stderr.write(
      `Node \`${parsed.nodeId}\` has no output named \`${parsed.outputKey}\` in run \`${runId}\`.\n`,
    );
    return 1;
  }
  // Pick the latest iteration (max iteration) among matches when no explicit
  // iteration was given.
  const chosen = matches.reduce(
    (best, r) => (r.iteration > best.iteration ? r : best),
    matches[0] as NodeOutputRow,
  );
  // Dispatch by type.
  if (parsed.filename !== undefined) {
    if (chosen.outputType !== "directory") {
      input.io.stderr.write(
        `Selector includes a filename but output \`${parsed.outputKey}\` is type \`${chosen.outputType}\`.\n`,
      );
      return 1;
    }
    // Reject any `..` segment to prevent traversal.
    const segments = parsed.filename.split(/[\\/]/);
    if (segments.some((s) => s === "..")) {
      input.io.stderr.write("Path traversal segments (`..`) not allowed in filename.\n");
      return 1;
    }
    const filePath = path.join(chosen.path, parsed.filename);
    try {
      await streamFile(filePath, input.io);
    } catch (err) {
      input.io.stderr.write(`Could not read ${filePath}: ${(err as Error).message}\n`);
      return 1;
    }
    return 0;
  }
  // No filename. For directory, list files. For value/file, stream contents.
  if (chosen.outputType === "directory") {
    input.io.stdout.write(`${chosen.path}:\n`);
    try {
      const files = await listDirectoryFiles(chosen.path);
      for (const f of files) {
        input.io.stdout.write(`  ${f.relativePath}  ${f.size}\n`);
      }
    } catch (err) {
      input.io.stderr.write(`Could not list ${chosen.path}: ${(err as Error).message}\n`);
      return 1;
    }
    return 0;
  }
  try {
    await streamFile(chosen.path, input.io);
  } catch (err) {
    input.io.stderr.write(`Could not read ${chosen.path}: ${(err as Error).message}\n`);
    return 1;
  }
  return 0;
}

async function streamFile(filePath: string, io: IO): Promise<void> {
  // Check existence first so we can produce a clear error.
  statSync(filePath);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      io.stdout.write(chunk as Buffer);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
}
