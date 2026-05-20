import { readFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeExecutor } from "../executor/claude.js";
import { ExecutorRegistry } from "../executor/registry.js";
import { openDefaultRunStore } from "../storage/open.js";
import type { ListRunsFilter, RunStore } from "../storage/run-store.js";
import { FactoryWatcher } from "./factories.js";
import { type Method, Router } from "./router.js";
import { RunRegistry } from "./run-registry.js";
import { sseResponse } from "./sse.js";

export interface StartDaemonOptions {
  dir: string;
  host: string;
  port: number;
  /** Optional override of the executor registry factory (tests). */
  buildRegistry?: () => ExecutorRegistry;
  /** Optional override of where static viewer assets live. */
  webRoot?: string;
  /**
   * Optional pre-opened run-history store. The daemon takes ownership and
   * closes it on shutdown. Omit to open the default SQLite store via
   * `openDefaultRunStore(dir)`. Pass `null` to disable persistence entirely
   * (tests that don't want a DB file).
   */
  store?: RunStore | null;
}

export interface DaemonHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"]);

function defaultBuildRegistry(): ExecutorRegistry {
  const reg = new ExecutorRegistry();
  reg.register(new ClaudeExecutor());
  return reg;
}

function defaultWebRoot(): string {
  // When running from `dist/`, web assets are at dist/serve/web (copied at
  // build time). When running from `src/` (e.g. vitest), use the source path.
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "web");
}

export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  if (!LOOPBACK.has(options.host)) {
    throw new Error(
      `minifac serve refuses to bind non-loopback host "${options.host}". ` +
        `Allowed: ${[...LOOPBACK].join(", ")}.`,
    );
  }

  const watcher = new FactoryWatcher(options.dir);
  await watcher.start();
  let store: RunStore | undefined;
  if (options.store === null) {
    store = undefined;
  } else if (options.store !== undefined) {
    store = options.store;
  } else {
    try {
      store = await openDefaultRunStore(options.dir);
    } catch {
      store = undefined;
    }
  }
  const runs = new RunRegistry(options.buildRegistry ?? defaultBuildRegistry, store);
  await runs.hydrate();
  const webRoot = options.webRoot ?? defaultWebRoot();

  const router = buildApiRouter();

  const server = createServer((req, res) => {
    handleRequest(req, res, { router, watcher, runs, webRoot }).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "internal_error", message: (err as Error).message }));
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr !== null ? addr.port : options.port;

  return {
    host: options.host,
    port: boundPort,
    async close(): Promise<void> {
      watcher.close();
      runs.closeAllSubscribers();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (store) {
        try {
          await store.close();
        } catch {
          // best effort
        }
      }
    },
  };
}

type RouteId =
  | "list_factories"
  | "get_factory"
  | "list_runs"
  | "get_run"
  | "post_run"
  | "run_events";

function buildApiRouter(): Router<RouteId> {
  const r = new Router<RouteId>();
  r.add("GET", "/api/factories", "list_factories");
  r.add("GET", "/api/factories/:id", "get_factory");
  r.add("GET", "/api/runs", "list_runs");
  r.add("POST", "/api/runs", "post_run");
  r.add("GET", "/api/runs/:id", "get_run");
  r.add("GET", "/api/runs/:id/events", "run_events");
  return r;
}

interface RequestDeps {
  router: Router<RouteId>;
  watcher: FactoryWatcher;
  runs: RunRegistry;
  webRoot: string;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const pathname = url.pathname;

  // Static viewer for non-/api paths.
  if (!pathname.startsWith("/api/") && pathname !== "/api") {
    await handleStatic(req, res, deps.webRoot, pathname);
    return;
  }

  const match = deps.router.match(req.method ?? "", pathname);
  if (match.kind === "not_found") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (match.kind === "method_not_allowed") {
    res.setHeader("Allow", match.allowed.join(", "));
    sendJson(res, 405, { error: "method_not_allowed", allowed: match.allowed });
    return;
  }

  const { handler, params } = match.match;
  switch (handler) {
    case "list_factories":
      handleListFactories(res, deps);
      return;
    case "get_factory":
      handleGetFactory(res, deps, params.id ?? "");
      return;
    case "list_runs":
      await handleListRuns(res, deps, url);
      return;
    case "get_run":
      await handleGetRun(res, deps, params.id ?? "");
      return;
    case "post_run":
      await handlePostRun(req, res, deps);
      return;
    case "run_events":
      handleRunEvents(req, res, deps, params.id ?? "");
      return;
  }
}

function handleListFactories(res: ServerResponse, deps: RequestDeps): void {
  const factories = deps.watcher
    .list()
    .map((e) =>
      e.kind === "ok"
        ? { id: e.id, path: e.path, name: e.name }
        : { id: e.id, path: e.path, error: e.error },
    );
  sendJson(res, 200, { factories });
}

function handleGetFactory(res: ServerResponse, deps: RequestDeps, id: string): void {
  const e = deps.watcher.get(id);
  if (!e) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (e.kind === "err") {
    sendJson(res, 422, { id: e.id, path: e.path, error: e.error });
    return;
  }
  sendJson(res, 200, {
    id: e.id,
    path: e.path,
    name: e.name,
    nodes: e.loaded.factory.nodes,
    edges: e.loaded.factory.edges,
  });
}

const LIST_RUNS_LIMIT_CEILING = 200;
const LIST_RUNS_LIMIT_DEFAULT = 50;

async function handleListRuns(res: ServerResponse, deps: RequestDeps, url: URL): Promise<void> {
  const filter: ListRunsFilter = {};
  const factory = url.searchParams.get("factory");
  if (factory) filter.factoryName = factory;
  const change = url.searchParams.get("change");
  if (change) filter.change = change;
  const statusParam = url.searchParams.get("status");
  if (statusParam) {
    if (statusParam !== "running" && statusParam !== "succeeded" && statusParam !== "failed") {
      sendJson(res, 400, {
        error: "invalid_status",
        message: "status must be one of: running, succeeded, failed",
      });
      return;
    }
    filter.status = statusParam;
  }
  const limitParam = url.searchParams.get("limit");
  let limit = LIST_RUNS_LIMIT_DEFAULT;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (
      !Number.isFinite(parsed) ||
      String(parsed) !== limitParam.trim() ||
      parsed <= 0 ||
      parsed > LIST_RUNS_LIMIT_CEILING
    ) {
      sendJson(res, 400, {
        error: "invalid_limit",
        message: `limit must be a positive integer no greater than ${LIST_RUNS_LIMIT_CEILING}`,
      });
      return;
    }
    limit = parsed;
  }
  filter.limit = limit;

  const list = await deps.runs.listAsync(filter);
  const runs = list.map((r) => ({
    id: r.id,
    factoryId: r.factoryId,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  }));
  sendJson(res, 200, { runs });
}

async function handleGetRun(res: ServerResponse, deps: RequestDeps, id: string): Promise<void> {
  const r = await deps.runs.getWithEvents(id);
  if (!r) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  sendJson(res, 200, {
    id: r.id,
    factoryId: r.factoryId,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    result: r.result,
    events: r.events,
  });
}

async function handlePostRun(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: "invalid_json", message: (err as Error).message });
    return;
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const factoryId = typeof obj.factoryId === "string" ? obj.factoryId : "";
  const cwd = typeof obj.cwd === "string" ? obj.cwd : undefined;
  if (!factoryId) {
    sendJson(res, 400, { error: "missing_factory_id" });
    return;
  }
  if (cwd !== undefined && !path.isAbsolute(cwd)) {
    sendJson(res, 400, { error: "invalid_cwd", message: "cwd must be an absolute path" });
    return;
  }

  const entry = deps.watcher.get(factoryId);
  if (!entry) {
    sendJson(res, 404, { error: "factory_not_found", factoryId });
    return;
  }
  if (entry.kind === "err") {
    sendJson(res, 422, { error: "factory_invalid", factoryId, message: entry.error });
    return;
  }

  const startInput = cwd === undefined ? { factoryId } : { factoryId, cwd };
  const outcome = deps.runs.start(startInput, entry.loaded);
  if (!outcome.ok) {
    sendJson(res, 409, { error: outcome.code, activeRunId: outcome.activeRunId });
    return;
  }
  const r = outcome.run;
  sendJson(res, 201, {
    id: r.id,
    factoryId: r.factoryId,
    status: r.status,
    startedAt: r.startedAt,
  });
}

type LastEventIdParse =
  | { kind: "absent" }
  | { kind: "ok"; index: number }
  | { kind: "invalid"; raw: string };

function parseLastEventId(raw: string | undefined): LastEventIdParse {
  if (raw === undefined) return { kind: "absent" };
  if (!/^-?\d+$/.test(raw)) return { kind: "invalid", raw };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return { kind: "invalid", raw };
  return { kind: "ok", index: n };
}

function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestDeps,
  id: string,
): void {
  const run = deps.runs.get(id);
  if (!run) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const lastIdHeader = req.headers["last-event-id"];
  const lastIdRaw = Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader;
  const parsed = parseLastEventId(lastIdRaw);
  if (parsed.kind === "invalid") {
    sendJson(res, 400, {
      error: "invalid_last_event_id",
      message: "Last-Event-ID must be a non-negative integer",
    });
    return;
  }
  const lastIndex = parsed.kind === "ok" ? parsed.index : undefined;

  const writer = sseResponse(res);
  const sub = deps.runs.subscribe(
    id,
    lastIndex,
    (entry) => {
      if (entry.kind === "run_end") {
        writer.send("run_end", { status: entry.result.status, result: entry.result }, entry.index);
        writer.close();
      } else {
        writer.send(entry.kind, entry, entry.index);
      }
    },
    writer,
  );
  if (!sub) {
    writer.close();
    return;
  }

  req.on("close", () => {
    sub.unsubscribe();
    writer.close();
  });
}

async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  webRoot: string,
  pathname: string,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  let rel = pathname === "/" ? "/index.html" : pathname;
  // Reject obvious traversal in the raw input *before* resolving.
  if (rel.includes("\0")) {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  // Strip query (URL parsing already removed it; defensive).
  rel = rel.split("?")[0] ?? rel;

  const resolved = path.resolve(webRoot, `.${rel}`);
  const rootWithSep = webRoot.endsWith(path.sep) ? webRoot : webRoot + path.sep;
  if (resolved !== webRoot && !resolved.startsWith(rootWithSep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  let buf: Buffer;
  try {
    buf = await readFile(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    throw err;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType(resolved));
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(buf);
  }
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = c instanceof Buffer ? c : Buffer.from(c as string);
    total += chunk.length;
    if (total > 1_000_000) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return null;
  return JSON.parse(raw);
}

// Re-export for testing convenience.
export type { Method };
