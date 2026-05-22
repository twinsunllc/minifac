import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Client as ClientCls } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutputDef } from "../factory/schema.js";
import { type RunnerMcpServer, startRunnerMcpServer } from "./mcp-server.js";

/**
 * In-process MCP client transport: speaks the SDK's stdio framing over a
 * raw net.Socket. Lets tests drive the server without spawning a wrapper
 * subprocess.
 */
class SocketClientTransport {
  private socket: net.Socket;
  private readBuffer = new ReadBuffer();
  // biome-ignore lint/suspicious/noExplicitAny: SDK's Transport interface uses JSONRPCMessage
  onmessage?: (msg: any) => void;
  onerror?: (err: Error) => void;
  onclose?: () => void;

  constructor(socketPath: string) {
    this.socket = net.createConnection(socketPath);
    this.socket.on("data", (chunk) => {
      this.readBuffer.append(chunk);
      this.processBuffer();
    });
    this.socket.on("error", (err) => this.onerror?.(err));
    this.socket.on("close", () => this.onclose?.());
  }

  private processBuffer(): void {
    while (true) {
      try {
        const msg = this.readBuffer.readMessage();
        if (msg === null) break;
        this.onmessage?.(msg);
      } catch (err) {
        this.onerror?.(err as Error);
        break;
      }
    }
  }

  async start(): Promise<void> {
    if (this.socket.connecting) {
      await new Promise<void>((resolve, reject) => {
        const ok = () => {
          this.socket.off("error", err);
          resolve();
        };
        const err = (e: Error) => {
          this.socket.off("connect", ok);
          reject(e);
        };
        this.socket.once("connect", ok);
        this.socket.once("error", err);
      });
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: JSONRPCMessage
  async send(message: any): Promise<void> {
    const json = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(json, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

async function connectClient(socketPath: string): Promise<Client> {
  const transport = new SocketClientTransport(socketPath);
  const client = new ClientCls({ name: "test-client", version: "0.0.1" }, {});
  // biome-ignore lint/suspicious/noExplicitAny: SDK accepts any Transport
  await client.connect(transport as any);
  return client;
}

interface Harness {
  tmpRoot: string;
  outputsRoot: string;
  runId: string;
  server: RunnerMcpServer;
  outputsByCall: Array<{ nodeId: string; key: string; value: unknown }>;
}

async function setupHarness(): Promise<Harness> {
  // Use /tmp directly to keep the socket path short (unix sockets are
  // capped around 104 chars on macOS).
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "minfc-"));
  const runId = "abcd";
  const outputsRoot = path.join(tmpRoot, "outputs", runId);
  const outputsByCall: Array<{ nodeId: string; key: string; value: unknown }> = [];
  const server = await startRunnerMcpServer({
    runId,
    outputsRoot,
    onOutput: (nodeId, key, value) => {
      outputsByCall.push({ nodeId, key, value });
    },
  });
  return { tmpRoot, outputsRoot, runId, server, outputsByCall };
}

async function teardown(h: Harness): Promise<void> {
  await h.server.close();
  await rm(h.tmpRoot, { recursive: true, force: true });
}

async function makeOutputsDir(h: Harness, nodeId: string): Promise<string> {
  const dir = path.join(h.outputsRoot, nodeId, "1");
  await rm(dir, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("startRunnerMcpServer — lifecycle", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("binds a sibling socket file relative to outputsRoot", async () => {
    const expected = path.resolve(h.outputsRoot, "..", `${h.runId}.mcp.sock`);
    expect(h.server.socketPath).toBe(expected);
    const s = await stat(h.server.socketPath);
    expect(s.isSocket()).toBe(true);
  });

  it("removes the socket file on close()", async () => {
    const sp = h.server.socketPath;
    await h.server.close();
    await expect(stat(sp)).rejects.toThrow();
    // Re-bind the same socket should succeed (file is gone).
    h.server = await startRunnerMcpServer({ runId: h.runId, outputsRoot: h.outputsRoot });
  });

  it("close() is idempotent", async () => {
    await h.server.close();
    await expect(h.server.close()).resolves.toBeUndefined();
  });

  it("reclaims a stale socket file at startup", async () => {
    const sp = h.server.socketPath;
    await h.server.close();
    // Drop a stale file at the path.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sp, "stale", { encoding: "utf8" });
    h.server = await startRunnerMcpServer({ runId: h.runId, outputsRoot: h.outputsRoot });
    const s = await stat(h.server.socketPath);
    expect(s.isSocket()).toBe(true);
  });

  it("concurrent runs use distinct sockets", async () => {
    const outputsRootB = path.join(h.tmpRoot, "outputs", "wxyz");
    const serverB = await startRunnerMcpServer({ runId: "wxyz", outputsRoot: outputsRootB });
    expect(serverB.socketPath).not.toBe(h.server.socketPath);
    const sA = await stat(h.server.socketPath);
    const sB = await stat(serverB.socketPath);
    expect(sA.isSocket()).toBe(true);
    expect(sB.isSocket()).toBe(true);
    await serverB.close();
  });
});

describe("startRunnerMcpServer — tool registration / scoping", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("registers one tool per `type: value` output and skips file/dir outputs", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    const outputs: Record<string, OutputDef> = {
      findings: { type: "value", required: true },
      summary: { type: "value", required: false },
      patch: { type: "file", filename: "patch.diff", required: true },
      logs: { type: "directory", required: false },
    };
    h.server.registerNodeOutputs("propose", outDir, outputs);
    const client = await connectClient(h.server.socketPath);
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(["mcp__minifac__report_findings", "mcp__minifac__report_summary"]);
    } finally {
      await client.close();
    }
  });

  it("tool description sources from the declaration when present", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    const outputs: Record<string, OutputDef> = {
      findings: {
        type: "value",
        required: true,
        description: "Code review findings as an array of issue objects.",
      },
    };
    h.server.registerNodeOutputs("propose", outDir, outputs);
    const client = await connectClient(h.server.socketPath);
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === "mcp__minifac__report_findings");
      expect(tool?.description).toBe("Code review findings as an array of issue objects.");
    } finally {
      await client.close();
    }
  });

  it("tool description falls back to a generic form when no description", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    h.server.registerNodeOutputs("propose", outDir, {
      notes: { type: "value", required: false },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === "mcp__minifac__report_notes");
      expect(tool?.description).toBe("Report the notes output for this node.");
    } finally {
      await client.close();
    }
  });

  it("per-node scoping: B does not see A's tools after de-registration", async () => {
    const outA = await makeOutputsDir(h, "A");
    h.server.registerNodeOutputs("A", outA, {
      findings: { type: "value", required: true },
    });
    let client = await connectClient(h.server.socketPath);
    let names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("mcp__minifac__report_findings");
    await client.close();

    h.server.clearNodeOutputs("A");
    const outB = await makeOutputsDir(h, "B");
    h.server.registerNodeOutputs("B", outB, {
      summary: { type: "value", required: false },
    });
    client = await connectClient(h.server.socketPath);
    try {
      names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(["mcp__minifac__report_summary"]);
    } finally {
      await client.close();
    }
  });

  it("late tool call after de-registration returns an MCP unknown-tool error", async () => {
    const outA = await makeOutputsDir(h, "A");
    h.server.registerNodeOutputs("A", outA, {
      findings: { type: "value", required: true },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      h.server.clearNodeOutputs("A");
      const res = await client
        .callTool({
          name: "mcp__minifac__report_findings",
          arguments: { value: [] },
        })
        .catch((e: Error) => ({ error: e.message }));
      expect("error" in res ? res.error : JSON.stringify(res)).toMatch(/not found|unknown/i);
    } finally {
      await client.close();
    }
  });
});

describe("startRunnerMcpServer — MCP-to-filesystem bridge", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("writes <key>.json on a successful tool call and invokes onOutput", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    h.server.registerNodeOutputs("propose", outDir, {
      findings: { type: "value", required: true, shape: { items: "array" } },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      const payload = [{ severity: "high", note: "x" }];
      const res = await client.callTool({
        name: "mcp__minifac__report_findings",
        arguments: { value: payload },
      });
      expect(res.isError).not.toBe(true);
      const contents = await readFile(path.join(outDir, "findings.json"), "utf8");
      expect(JSON.parse(contents)).toEqual(payload);
      expect(h.outputsByCall).toEqual([{ nodeId: "propose", key: "findings", value: payload }]);
    } finally {
      await client.close();
    }
  });

  it("returns MCP error on schema mismatch and leaves disk untouched", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    h.server.registerNodeOutputs("propose", outDir, {
      summary: {
        type: "value",
        required: true,
        shape: { fields: { foo: "string" } },
      },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      const res = await client
        .callTool({
          name: "mcp__minifac__report_summary",
          arguments: { value: 42 },
        })
        .catch((e: Error) => ({ error: e.message, isError: true }) as const);
      const before = await readdir(outDir);
      expect(before).not.toContain("summary.json");
      // Either an SDK-side validation error (thrown) or our bridge-side
      // error response. Both satisfy the spec.
      const isError = (res as { isError?: boolean }).isError === true;
      expect(isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("repeated calls overwrite atomically; the latest write wins", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    h.server.registerNodeOutputs("propose", outDir, {
      findings: { type: "value", required: true },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      await client.callTool({
        name: "mcp__minifac__report_findings",
        arguments: { value: [] },
      });
      await client.callTool({
        name: "mcp__minifac__report_findings",
        arguments: { value: [{ id: 1 }] },
      });
      const contents = await readFile(path.join(outDir, "findings.json"), "utf8");
      expect(JSON.parse(contents)).toEqual([{ id: 1 }]);
      // No orphan tmp files left behind.
      const entries = await readdir(outDir);
      expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("writes the file under the dispatching node's outputsDir, not another node's", async () => {
    const outA = await makeOutputsDir(h, "A");
    const outB = await makeOutputsDir(h, "B");
    h.server.registerNodeOutputs("A", outA, {
      findings: { type: "value", required: true },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      await client.callTool({
        name: "mcp__minifac__report_findings",
        arguments: { value: ["ok"] },
      });
      await expect(stat(path.join(outA, "findings.json"))).resolves.toBeTruthy();
      await expect(stat(path.join(outB, "findings.json"))).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("derived schema accepts arrays for array-shaped outputs", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    h.server.registerNodeOutputs("propose", outDir, {
      findings: { type: "value", required: true, shape: "array" },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      const res = await client.callTool({
        name: "mcp__minifac__report_findings",
        arguments: { value: [1, 2, 3] },
      });
      expect(res.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it("derived schema accepts objects for object-shaped outputs", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    h.server.registerNodeOutputs("propose", outDir, {
      summary: { type: "value", required: true, shape: "object" },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      const res = await client.callTool({
        name: "mcp__minifac__report_summary",
        arguments: { value: { foo: "bar", extra: 42 } },
      });
      expect(res.isError).not.toBe(true);
      const contents = await readFile(path.join(outDir, "summary.json"), "utf8");
      expect(JSON.parse(contents)).toEqual({ extra: 42, foo: "bar" });
    } finally {
      await client.close();
    }
  });
});

describe("startRunnerMcpServer — atomic-rename + onOutput", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("no partial file remains visible to the validator after a normal call", async () => {
    const outDir = await makeOutputsDir(h, "propose");
    h.server.registerNodeOutputs("propose", outDir, {
      findings: { type: "value", required: true },
    });
    const client = await connectClient(h.server.socketPath);
    try {
      await client.callTool({
        name: "mcp__minifac__report_findings",
        arguments: { value: [{ id: 1 }] },
      });
      const entries = await readdir(outDir);
      // Only the final file, no orphan `.tmp-*` siblings.
      expect(entries.sort()).toEqual(["findings.json"]);
    } finally {
      await client.close();
    }
  });
});
