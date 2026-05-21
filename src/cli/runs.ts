import type {
  ListRunsFilter,
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
      return 0;
    }
  }
  input.io.stderr.write("Stopped following: poll cap reached.\n");
  return 0;
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

  // Prefix resolution: scan a bounded recent window. Realistically a run id
  // is a UUID, so two of them sharing a 4-char prefix is extremely rare;
  // a generous scan is fine.
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
