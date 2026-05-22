// End-to-end tests that exercise the full MCP transport path: the runner
// starts the per-run MCP server, an in-process Claude stub uses the SDK's
// client to call a registered tool, the bridge lands the file, the
// validator passes. Also covers the non-MCP fallback and the
// missing_required_output override under MCP.

import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client as ClientCls } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutorRegistry } from "../executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode, RunContext } from "../executor/types.js";
import type { LoadedFactory } from "../factory/loader.js";
import type { Factory } from "../factory/schema.js";
import * as worktreeConfig from "../worktree/config.js";
import { runFactory } from "./run.js";

// Same socket-client transport as in mcp-server.test.ts. Duplicated to
// keep the test file self-contained.
class SocketClientTransport {
  private socket: net.Socket;
  private readBuffer = new ReadBuffer();
  // biome-ignore lint/suspicious/noExplicitAny: SDK's Transport interface
  onmessage?: (msg: any) => void;
  onerror?: (err: Error) => void;
  onclose?: () => void;

  constructor(socketPath: string) {
    this.socket = net.createConnection(socketPath);
    this.socket.on("data", (chunk) => {
      this.readBuffer.append(chunk);
      while (true) {
        try {
          const msg = this.readBuffer.readMessage();
          if (msg === null) break;
          this.onmessage?.(msg);
        } catch (e) {
          this.onerror?.(e as Error);
          break;
        }
      }
    });
    this.socket.on("error", (err) => this.onerror?.(err));
    this.socket.on("close", () => this.onclose?.());
  }
  async start(): Promise<void> {
    if (this.socket.connecting) {
      await new Promise<void>((resolve, reject) => {
        this.socket.once("connect", () => resolve());
        this.socket.once("error", (e) => reject(e));
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

function wrap(factory: Factory, sourceDir = "/tmp"): LoadedFactory {
  return {
    factory,
    sourcePath: path.join(sourceDir, "f.yaml"),
    sourceDir,
  };
}

/** Stub Claude-like executor that connects to the configured MCP socket
 * (read from `ctx.mcpConfigPath`) and calls `mcp__minifac__report_findings`
 * during dispatch. Used to exercise the MCP transport in-process without
 * spawning the real CLI or the wrapper script. */
class McpClientStub implements NodeExecutor {
  readonly type = "claude-stub";
  readonly supportsMcp = true;
  readonly supportsNudge = false;
  scriptByNode: Record<string, { tool: string; arg: unknown } | "no-tool"> = {};
  constructor(scripts: Record<string, { tool: string; arg: unknown } | "no-tool"> = {}) {
    this.scriptByNode = scripts;
  }
  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    yield { kind: "status", status: "started" };
    const cfgPath = ctx.mcpConfigPath;
    if (cfgPath) {
      const body = JSON.parse(await readFile(cfgPath, "utf8")) as {
        mcpServers: { minifac: { args: string[] } };
      };
      const args = body.mcpServers.minifac.args;
      const socketPath = args[args.length - 1] as string;
      const transport = new SocketClientTransport(socketPath);
      const client = new ClientCls({ name: "stub", version: "0.0.1" }, {});
      // biome-ignore lint/suspicious/noExplicitAny: SDK accepts any Transport
      await client.connect(transport as any);
      const script = this.scriptByNode[node.id];
      if (script && script !== "no-tool") {
        await client.callTool({
          name: script.tool,
          arguments: script.arg as Record<string, unknown>,
        });
      }
      await client.close();
    }
    yield { kind: "status", status: "succeeded" };
  }
}

/** Filesystem-only stub: writes the declared JSON file directly. Used for
 * the non-MCP fallback test. */
class FsWriterStub implements NodeExecutor {
  readonly type = "fs-writer";
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  constructor(private contents: unknown = []) {}
  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    yield { kind: "status", status: "started" };
    if (node.outputs) {
      for (const key of Object.keys(node.outputs)) {
        await mkdir(ctx.outputsDir, { recursive: true });
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path.join(ctx.outputsDir, `${key}.json`), JSON.stringify(this.contents));
      }
    }
    yield { kind: "status", status: "succeeded" };
  }
}

describe("run.ts MCP integration — end-to-end", () => {
  let tmpHome: string;
  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(tmpdir(), "mfe-"));
    vi.spyOn(worktreeConfig, "minifacHome").mockReturnValue(tmpHome);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("MCP path: server starts, tool registers, file lands, validator passes, server stops", async () => {
    const registry = new ExecutorRegistry();
    registry.register(
      new McpClientStub({
        report: {
          tool: "mcp__minifac__report_findings",
          arg: { value: [{ id: 1 }, { id: 2 }] },
        },
      }),
    );
    const factory: Factory = {
      name: "f",
      brief: "none",
      nodes: {
        report: {
          executor: "claude-stub",
          terminal: true,
          outputs: { findings: { type: "value", required: true } },
        },
      },
      edges: [],
    };
    const result = await runFactory(wrap(factory), { registry, runId: "r1" });
    expect(result.status).toBe("succeeded");

    const outDir = path.join(tmpHome, "outputs", "r1", "report", "1");
    const contents = JSON.parse(await readFile(path.join(outDir, "findings.json"), "utf8"));
    expect(contents).toEqual([{ id: 1 }, { id: 2 }]);

    // Server cleanup: socket file gone.
    const sockPath = path.join(tmpHome, "outputs", "r1.mcp.sock");
    await expect(stat(sockPath)).rejects.toThrow();

    // `.mcp.json` cleanup: file is gone, per ADR-0029 D5.
    await expect(stat(path.join(outDir, ".mcp.json"))).rejects.toThrow();
  });

  it("non-MCP fallback: model writes file directly, validator passes", async () => {
    const registry = new ExecutorRegistry();
    registry.register(new FsWriterStub([{ ok: true }]));
    const factory: Factory = {
      name: "f",
      brief: "none",
      nodes: {
        writer: {
          executor: "fs-writer",
          terminal: true,
          outputs: { findings: { type: "value", required: true } },
        },
      },
      edges: [],
    };
    const result = await runFactory(wrap(factory), { registry, runId: "r2" });
    expect(result.status).toBe("succeeded");

    const outDir = path.join(tmpHome, "outputs", "r2", "writer", "1");
    const contents = JSON.parse(await readFile(path.join(outDir, "findings.json"), "utf8"));
    expect(contents).toEqual([{ ok: true }]);

    // Server still ran (other nodes might use it), socket gone after termination.
    await expect(stat(path.join(tmpHome, "outputs", "r2.mcp.sock"))).rejects.toThrow();
    // No `.mcp.json` for non-MCP executor.
    await expect(stat(path.join(outDir, ".mcp.json"))).rejects.toThrow();
  });

  it("missing_required_output fires under MCP when tool not called and no fallback file", async () => {
    const registry = new ExecutorRegistry();
    registry.register(new McpClientStub({ report: "no-tool" }));
    const factory: Factory = {
      name: "f",
      brief: "none",
      nodes: {
        report: {
          executor: "claude-stub",
          terminal: true,
          outputs: { findings: { type: "value", required: true } },
        },
      },
      edges: [],
    };
    const stderrLines: string[] = [];
    const result = await runFactory(wrap(factory), {
      registry,
      runId: "r3",
      onEvent: (e) => {
        if (e.event.kind === "stderr") stderrLines.push(e.event.line);
      },
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("node_failed");
    // Detail string mentions both transport options.
    const joined = stderrLines.join("\n");
    expect(joined).toMatch(/missing_required_output/);
    expect(joined).toMatch(/mcp__minifac__report_findings/);
    expect(joined).toMatch(/findings\.json/);
  });
});
