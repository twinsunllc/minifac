// Per-run inline MCP server.
//
// The runner starts exactly one of these per run (see `runFactory`). Tool
// surface is mutated as nodes dispatch: `registerNodeOutputs` registers the
// dispatching node's `type: "value"` outputs as MCP tools, `clearNodeOutputs`
// removes them at termination. Tool calls bridge into the v1 filesystem
// layout established by `node-outputs` — the bridge writes
// `<outputs_dir>/<key>.json` atomically (temp sibling + rename) so the
// validator's on-disk scan picks the file up unchanged.
//
// Architecture notes:
//
// - One unix socket per run. Sibling of the per-run outputs directory at
//   `<outputs_root>/<run-id>.mcp.sock`. Per-run scoping matches the rest of
//   the run state tree and lets concurrent runs use distinct sockets without
//   coordination.
// - One McpServer instance per *connection*. The `claude` CLI spawns its
//   own MCP client (the small stdio wrapper in `mcp-stdio-wrapper.ts`) per
//   dispatch, dials the socket, and bridges its stdio to the socket. When
//   the connection lands we create a fresh McpServer, attach an SDK
//   `StdioServerTransport` using the socket as both Readable and Writable,
//   and register the current dispatch's tools on it.
// - State of truth is a `Map<nodeId, { outputsDir, outputs }>` kept on the
//   server handle. Per-connection registered tools track the SDK's
//   `RegisteredTool` references so we can call `.remove()` when the runner
//   de-registers a node's outputs.
//
// See `openspec/specs/graph-runner/spec.md` ("Per-run MCP server
// lifecycle", "Per-node MCP tool registration for `value` outputs",
// "MCP-to-filesystem bridge for `value` output tool calls").

import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import * as net from "node:net";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { OutputDef, OutputValueDef } from "../factory/schema.js";
import { deriveShapeKind, validateValuePayload } from "./mcp-schema.js";

/** Public callback signature: invoked once per successful tool-call bridge. */
export type OnOutputCallback = (nodeId: string, key: string, value: unknown) => void;

export interface RunnerMcpServer {
  /** Absolute path to the unix socket the server is bound to. */
  readonly socketPath: string;
  /** Register MCP tools for `node`'s declared `type: "value"` outputs. The
   * runner SHALL call this before dispatching `node` when the resolved
   * executor's `supportsMcp` is `true`. */
  registerNodeOutputs(
    nodeId: string,
    outputsDir: string,
    outputs: Readonly<Record<string, OutputDef>>,
  ): void;
  /** De-register every tool previously registered for `nodeId`. Late tool
   * calls arriving after this call resolve as "unknown tool" errors at the
   * MCP layer. */
  clearNodeOutputs(nodeId: string): void;
  /** Stop the server: close all connections, close the listening socket,
   * remove the socket file from disk. Idempotent. */
  close(): Promise<void>;
}

export interface StartRunnerMcpServerOptions {
  runId: string;
  outputsRoot: string;
  onOutput?: OnOutputCallback;
}

interface NodeRegistration {
  outputsDir: string;
  outputs: Map<string, OutputValueDef>;
}

interface ActiveConnection {
  server: McpServer;
  socket: net.Socket;
  /** Per-node, per-key registered tool references so we can `.remove()` them
   * cleanly on de-registration. */
  tools: Map<string, Map<string, { remove(): void }>>;
}

/**
 * Compute the per-run socket path. Sibling of the per-run outputs tree.
 * Per ADR-0029 D9.
 */
export function runnerSocketPath(outputsRoot: string, runId: string): string {
  return path.join(outputsRoot, "..", `${runId}.mcp.sock`);
}

/**
 * Start the per-run MCP server. Resolves once the socket is bound and ready
 * to accept connections. Rejects if the socket cannot be bound (e.g. a
 * stale socket file is in the way and reclaim fails).
 */
export async function startRunnerMcpServer(
  opts: StartRunnerMcpServerOptions,
): Promise<RunnerMcpServer> {
  const socketPath = path.resolve(runnerSocketPath(opts.outputsRoot, opts.runId));

  const registrations = new Map<string, NodeRegistration>();
  const connections = new Set<ActiveConnection>();
  let closed = false;

  // mkdirp the socket's parent directory. The per-run outputs root is the
  // sibling directory and may not exist yet at run-setup time; the bind
  // would otherwise fail with EACCES / ENOENT.
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o755 });

  // Best-effort reclaim of a stale socket file. If it points at a still-live
  // listener the bind below will fail with EADDRINUSE and we surface that.
  try {
    await unlink(socketPath);
  } catch {
    /* most common case: ENOENT — fine */
  }

  const server = net.createServer((socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    handleConnection(socket).catch((err) => {
      // Mirror the SDK's pattern of swallowing per-connection errors;
      // we log to stderr so an operator debugging an MCP issue can see them.
      console.error(`[minifac mcp] connection error: ${(err as Error).message}`);
      try {
        socket.destroy();
      } catch {
        /* already destroyed */
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  async function handleConnection(socket: net.Socket): Promise<void> {
    const mcp = new McpServer(
      { name: "minifac", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    const transport = new StdioServerTransport(socket, socket);
    const active: ActiveConnection = {
      server: mcp,
      socket,
      tools: new Map(),
    };
    connections.add(active);

    socket.on("close", () => {
      connections.delete(active);
      mcp.close().catch(() => {
        /* best-effort; the connection is already gone */
      });
    });
    socket.on("error", () => {
      /* surfaced via close */
    });

    // Apply the current registration state to this fresh connection.
    for (const [nodeId, reg] of registrations) {
      applyRegistrationToConnection(active, nodeId, reg);
    }

    await mcp.connect(transport);
  }

  function applyRegistrationToConnection(
    active: ActiveConnection,
    nodeId: string,
    reg: NodeRegistration,
  ): void {
    let perNode = active.tools.get(nodeId);
    if (!perNode) {
      perNode = new Map();
      active.tools.set(nodeId, perNode);
    }
    for (const [key, def] of reg.outputs) {
      if (perNode.has(key)) continue;
      const handle = registerSingleTool(active.server, nodeId, reg.outputsDir, key, def);
      perNode.set(key, handle);
    }
  }

  function registerSingleTool(
    mcp: McpServer,
    nodeId: string,
    outputsDir: string,
    key: string,
    def: OutputValueDef,
  ): { remove(): void } {
    const description =
      def.description && def.description.length > 0
        ? def.description
        : `Report the ${key} output for this node.`;
    const inputSchema = buildToolInputZodShape(def.shape);

    const handle = mcp.registerTool(
      `mcp__minifac__report_${key}`,
      {
        description,
        inputSchema,
      },
      // biome-ignore lint/suspicious/noExplicitAny: SDK callback signature is generic
      async (args: any): Promise<any> => {
        return await handleToolCall(nodeId, outputsDir, key, def, args);
      },
    );
    return { remove: () => handle.remove() };
  }

  async function handleToolCall(
    nodeId: string,
    outputsDir: string,
    key: string,
    def: OutputValueDef,
    args: { value: unknown } | undefined,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    // (a) defensive double-check against the derived schema. The SDK
    // already validated at the input layer; we re-validate here so an SDK
    // change that loosens validation cannot silently corrupt outputs.
    const payload = args?.value;
    const check = validateValuePayload(def.shape, payload);
    if (!check.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `output "${key}" schema mismatch: ${check.error}`,
          },
        ],
      };
    }

    // (b) serialize deterministically — sorted keys, 2-space indent.
    const serialized = `${stableJsonStringify(check.value)}\n`;

    // (c) atomic write: tmp sibling + rename. The tmp filename uses a
    // grammar that doesn't match the validator's `<key>.*` glob (a stray
    // dot-segment after `<key>.tmp-` keeps the validator from picking up
    // orphan temp files as legitimate matches).
    const finalPath = path.join(outputsDir, `${key}.json`);
    const tmpPath = path.join(outputsDir, `${key}.tmp-${randomBytes(8).toString("hex")}.json`);
    await writeFile(tmpPath, serialized, { encoding: "utf8", mode: 0o644 });
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort cleanup of the orphan tmp file. The rename failure
      // surfaces to the caller as a tool error.
      try {
        await unlink(tmpPath);
      } catch {
        /* leave for `prune --outputs` */
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `output "${key}" failed to land at ${finalPath}: ${(err as Error).message}`,
          },
        ],
      };
    }

    // (d) update the runner's in-memory tracking.
    opts.onOutput?.(nodeId, key, check.value);

    // (e) return the absolute path of the written file.
    return {
      content: [
        {
          type: "text",
          text: `output "${key}" written to ${finalPath}`,
        },
      ],
    };
  }

  function removeNodeRegistrationFromAllConnections(nodeId: string): void {
    for (const active of connections) {
      const perNode = active.tools.get(nodeId);
      if (!perNode) continue;
      for (const tool of perNode.values()) {
        try {
          tool.remove();
        } catch {
          /* tool already gone */
        }
      }
      active.tools.delete(nodeId);
    }
  }

  return {
    socketPath,
    registerNodeOutputs(nodeId, outputsDir, outputs) {
      const valueOutputs = new Map<string, OutputValueDef>();
      for (const [k, d] of Object.entries(outputs)) {
        if (d.type === "value") {
          valueOutputs.set(k, d as OutputValueDef);
        }
      }
      // Even if there are no `value` outputs we record the registration so
      // `clearNodeOutputs` is symmetric — but we don't bother registering
      // tools when the map is empty.
      const reg: NodeRegistration = { outputsDir, outputs: valueOutputs };
      registrations.set(nodeId, reg);
      if (valueOutputs.size === 0) return;
      for (const active of connections) {
        applyRegistrationToConnection(active, nodeId, reg);
      }
    },
    clearNodeOutputs(nodeId) {
      registrations.delete(nodeId);
      removeNodeRegistrationFromAllConnections(nodeId);
    },
    async close() {
      if (closed) return;
      closed = true;
      // Close every active connection's McpServer and destroy its socket.
      const closeOps: Array<Promise<void>> = [];
      for (const active of connections) {
        try {
          active.socket.destroy();
        } catch {
          /* already destroyed */
        }
        closeOps.push(
          active.server.close().catch(() => {
            /* swallow */
          }),
        );
      }
      connections.clear();
      await Promise.allSettled(closeOps);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      try {
        await unlink(socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Build the `inputSchema` raw-shape object the SDK's `registerTool`
 * expects. The tool's single argument is `{ value: <derived> }`. */
function buildToolInputZodShape(shape: unknown): { value: z.ZodTypeAny } {
  const kind = deriveShapeKind(shape);
  switch (kind) {
    case "array":
      return { value: z.array(z.unknown()) };
    case "object":
      return { value: z.object({}).passthrough() };
    case "string":
      return { value: z.string() };
    case "number":
      return { value: z.number() };
    case "boolean":
      return { value: z.boolean() };
    default:
      return { value: z.unknown() };
  }
}

/**
 * Deterministic JSON serializer: sorts object keys recursively and pretty-
 * prints with a 2-space indent so the output file is diff-friendly when an
 * operator opens it after a run.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeysDeep(v));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeysDeep(obj[k]);
    }
    return sorted;
  }
  return value;
}
