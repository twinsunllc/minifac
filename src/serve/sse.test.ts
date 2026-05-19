import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sseResponse } from "./sse.js";

interface Harness {
  port: number;
  close(): Promise<void>;
  setHandler(fn: (writer: import("./sse.js").SseWriter) => void | Promise<void>): void;
}

function startServer(): Promise<Harness> {
  return new Promise((resolve) => {
    let handler: (writer: import("./sse.js").SseWriter) => void | Promise<void> = () => {};
    const server = createServer((_req, res) => {
      const w = sseResponse(res);
      Promise.resolve(handler(w)).catch(() => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        async close() {
          await new Promise<void>((r) => server.close(() => r()));
        },
        setHandler(fn) {
          handler = fn;
        },
      });
    });
  });
}

async function fetchText(port: number): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/`);
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  return await r.text();
}

describe("sseResponse", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startServer();
  });
  afterEach(async () => {
    await h.close();
  });

  it("emits frames in the documented format", async () => {
    h.setHandler((w) => {
      w.send("stdout", { line: "hi" }, 1);
      w.send("status", { status: "succeeded" }, 2);
      w.close();
    });
    const text = await fetchText(h.port);
    expect(text.startsWith(": ok\n\n")).toBe(true);
    expect(text).toContain(`id: 1\nevent: stdout\ndata: {"line":"hi"}\n\n`);
    expect(text).toContain(`id: 2\nevent: status\ndata: {"status":"succeeded"}\n\n`);
  });

  it("omits id: line when id is undefined", async () => {
    h.setHandler((w) => {
      w.send("noted", { ok: true });
      w.close();
    });
    const text = await fetchText(h.port);
    expect(text).toContain(`event: noted\ndata: {"ok":true}\n\n`);
    expect(text).not.toMatch(/^id:/m);
  });

  it("close() is idempotent", async () => {
    h.setHandler((w) => {
      w.send("a", { n: 1 }, 1);
      w.close();
      w.close();
      expect(w.closed).toBe(true);
    });
    await fetchText(h.port);
  });
});
