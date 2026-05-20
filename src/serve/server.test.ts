import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode } from "../executor/types.js";
import { type DaemonHandle, startDaemon } from "./server.js";

const HELLO_YAML = `name: hello
nodes:
  a:
    executor: test
    terminal: true
edges: []
`;

const BROKEN_YAML = `name: bad
nodes:
  oops:
    terminal: true
edges: []
`;

function buildScripted(scripts: Record<string, NodeEvent[]>): () => ExecutorRegistry {
  return () => {
    const reg = new ExecutorRegistry();
    const exec: NodeExecutor = {
      type: "test",
      async *run(node: ResolvedNode): AsyncIterable<NodeEvent> {
        const ev = scripts[node.id] ?? [{ kind: "status", status: "succeeded" }];
        for (const e of ev) yield e;
      },
    };
    reg.register(exec);
    return reg;
  };
}

interface Harness {
  handle: DaemonHandle;
  dir: string;
  base: string;
  close(): Promise<void>;
}

async function start(opts: { dir: string; web?: string }): Promise<Harness> {
  const handle = await startDaemon({
    dir: opts.dir,
    host: "127.0.0.1",
    port: 0,
    store: null,
    buildRegistry: buildScripted({
      a: [
        { kind: "stdout", line: "hello-line" },
        { kind: "status", status: "succeeded" },
      ],
    }),
    webRoot: opts.web,
  });
  return {
    handle,
    dir: opts.dir,
    base: `http://127.0.0.1:${handle.port}`,
    async close() {
      await handle.close();
    },
  };
}

describe("startDaemon http API", () => {
  let dir: string;
  let webDir: string;
  let h: Harness | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-srv-"));
    webDir = await mkdtemp(path.join(tmpdir(), "minifac-web-"));
    await writeFile(path.join(webDir, "index.html"), "<!doctype html><title>t</title>");
    await writeFile(path.join(webDir, "app.js"), "console.log('hi');");
  });
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
    await rm(dir, { recursive: true, force: true });
    await rm(webDir, { recursive: true, force: true });
  });

  it("refuses non-loopback host", async () => {
    await expect(startDaemon({ dir, host: "0.0.0.0", port: 0, webRoot: webDir })).rejects.toThrow(
      /non-loopback/,
    );
  });

  it("GET /api/factories lists valid and invalid factories", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    await writeFile(path.join(dir, "broken.yaml"), BROKEN_YAML);
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/factories`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { factories: Array<{ id: string; error?: string }> };
    const ids = body.factories.map((f) => f.id).sort();
    expect(ids).toEqual(["broken", "hello"]);
    const broken = body.factories.find((f) => f.id === "broken");
    expect(broken?.error).toBeTruthy();
  });

  it("GET /api/factories/:id returns 404 for unknown", async () => {
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/factories/nope`);
    expect(r.status).toBe(404);
  });

  it("GET /api/factories/:id returns 422 for known-but-broken", async () => {
    await writeFile(path.join(dir, "broken.yaml"), BROKEN_YAML);
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/factories/broken`);
    expect(r.status).toBe(422);
  });

  it("POST /api/runs starts a run for a known factory and returns 201", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factoryId: "hello" }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string; status: string };
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("running");
  });

  it("POST /api/runs returns 404 for unknown factory", async () => {
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factoryId: "nope" }),
    });
    expect(r.status).toBe(404);
  });

  it("POST /api/runs rejects relative cwd with 400", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factoryId: "hello", cwd: "./relative" }),
    });
    expect(r.status).toBe(400);
  });

  it("PUT on known path returns 405", async () => {
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/factories`, { method: "PUT" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toContain("GET");
  });

  it("unknown /api/ path returns 404", async () => {
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/nope`);
    expect(r.status).toBe(404);
  });

  it("GET / serves the static viewer's index.html", async () => {
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type") || "").toContain("text/html");
    const body = await r.text();
    expect(body).toContain("<title>t</title>");
  });

  it("path traversal on the static handler is refused", async () => {
    h = await start({ dir, web: webDir });
    // Browsers normalize, so we go raw via fetch with a manual URL.
    const r = await fetch(`${h.base}/../etc/passwd`);
    // Some clients normalize; either 403 or 404 is acceptable, but never 200.
    expect([403, 404]).toContain(r.status);
    const r2 = await fetch(`${h.base}/missing-file.html`);
    expect(r2.status).toBe(404);
  });

  it("GET /api/runs/:id/events streams events and emits a run_end frame", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    h = await start({ dir, web: webDir });
    const post = await fetch(`${h.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factoryId: "hello" }),
    });
    expect(post.status).toBe(201);
    const { id: runId } = (await post.json()) as { id: string };

    // Give the run a moment to complete so SSE replays buffered events
    // immediately and we can read to EOF.
    await new Promise((r) => setTimeout(r, 100));

    const r = await fetch(`${h.base}/api/runs/${runId}/events`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    expect(text).toContain("event: stdout");
    expect(text).toContain("event: run_end");
    expect(text).toMatch(/data:.*"succeeded"/);
  });

  it("starting a second run for the same factory while running returns 409", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    // Build a slow scripted registry inline.
    const handle = await startDaemon({
      dir,
      host: "127.0.0.1",
      port: 0,
      store: null,
      webRoot: webDir,
      buildRegistry: () => {
        const reg = new ExecutorRegistry();
        const exec: NodeExecutor = {
          type: "test",
          async *run(): AsyncIterable<NodeEvent> {
            await new Promise((r) => setTimeout(r, 200));
            yield { kind: "status", status: "succeeded" };
          },
        };
        reg.register(exec);
        return reg;
      },
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const a = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factoryId: "hello" }),
      });
      expect(a.status).toBe(201);
      const b = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factoryId: "hello" }),
      });
      expect(b.status).toBe(409);
      const body = (await b.json()) as { error: string; activeRunId: string };
      expect(body.error).toBe("run_in_flight");
      expect(body.activeRunId).toBeTruthy();
    } finally {
      await handle.close();
    }
  });

  it("SSE for an unknown run returns 404 without upgrading", async () => {
    h = await start({ dir, web: webDir });
    const r = await fetch(`${h.base}/api/runs/does-not-exist/events`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type") || "").not.toContain("text/event-stream");
  });

  it("GET /api/runs lists active runs", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    h = await start({ dir, web: webDir });
    const post = await fetch(`${h.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factoryId: "hello" }),
    });
    expect(post.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    const r = await fetch(`${h.base}/api/runs`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { runs: Array<{ factoryId: string }> };
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.runs[0]?.factoryId).toBe("hello");
  });

  it("shutdown actively terminates in-flight SSE subscribers", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    const handle = await startDaemon({
      dir,
      host: "127.0.0.1",
      port: 0,
      store: null,
      webRoot: webDir,
      buildRegistry: () => {
        const reg = new ExecutorRegistry();
        const exec: NodeExecutor = {
          type: "test",
          async *run(): AsyncIterable<NodeEvent> {
            yield { kind: "stdout", line: "starting" };
            await new Promise((r) => setTimeout(r, 10_000));
            yield { kind: "status", status: "succeeded" };
          },
        };
        reg.register(exec);
        return reg;
      },
    });
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const post = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factoryId: "hello" }),
      });
      expect(post.status).toBe(201);
      const { id: runId } = (await post.json()) as { id: string };

      // Give the runner time to emit the first stdout event so SSE has
      // something to send and is in live-tail mode.
      await new Promise((r) => setTimeout(r, 100));

      const ac = new AbortController();
      const sseResp = await fetch(`${base}/api/runs/${runId}/events`, { signal: ac.signal });
      expect(sseResp.status).toBe(200);
      expect(sseResp.headers.get("content-type")).toBe("text/event-stream");
      const reader = sseResp.body?.getReader();
      expect(reader).toBeTruthy();
      if (!reader) return;

      // Drain until we see the live subscriber registered + first frame arrived.
      // Without blocking forever, just read one chunk so we know the stream is live.
      const firstRead = await reader.read();
      expect(firstRead.done).toBe(false);

      // Now close the daemon and assert the stream ends within a small bound.
      const closePromise = handle.close();
      const drainPromise = (async () => {
        while (true) {
          const r = await reader.read();
          if (r.done) return;
        }
      })();
      const timeout = new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 1500),
      );
      const result = await Promise.race([
        Promise.all([closePromise, drainPromise]).then(() => "ok" as const),
        timeout,
      ]);
      expect(result).toBe("ok");
      ac.abort();
    } finally {
      // Best-effort second close (no-op if already closed).
      try {
        await handle.close();
      } catch {
        // ignore
      }
    }
  });

  it("Last-Event-ID with garbage value returns 400 without SSE upgrade", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    h = await start({ dir, web: webDir });
    const post = await fetch(`${h.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factoryId: "hello" }),
    });
    expect(post.status).toBe(201);
    const { id: runId } = (await post.json()) as { id: string };
    await new Promise((r) => setTimeout(r, 50));

    const r = await fetch(`${h.base}/api/runs/${runId}/events`, {
      headers: { "Last-Event-ID": "not-a-number" },
    });
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type") || "").not.toContain("text/event-stream");
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_last_event_id");
  });

  it("Last-Event-ID: 0 replays from index 1 (skips event 0)", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    h = await start({ dir, web: webDir });
    const post = await fetch(`${h.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ factoryId: "hello" }),
    });
    expect(post.status).toBe(201);
    const { id: runId } = (await post.json()) as { id: string };

    // Let the run finish so SSE replays a full buffered log to EOF.
    await new Promise((r) => setTimeout(r, 150));

    const r = await fetch(`${h.base}/api/runs/${runId}/events`, {
      headers: { "Last-Event-ID": "0" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = await r.text();
    // The event at index 0 must not appear; events at index >= 1 must.
    expect(text).not.toMatch(/^id: 0$/m);
    expect(text).toMatch(/^id: 1$/m);
  });
});
