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
// - One unix socket per run, in a fresh per-run directory under the OS
//   temp dir: `<tmpdir>/minifac-<run-id-prefix>-XXXXXX/mcp.sock`. The
//   socket deliberately does NOT live under `MINIFAC_HOME`: `sun_path` is
//   capped at 104 bytes on macOS (108 on Linux) and a deep `MINIFAC_HOME`
//   pushed the old `<outputs_root>/../<run-id>.mcp.sock` past it, so
//   `listen` failed with EINVAL and the run silently lost its MCP tools
//   (issue #35). `mkdtemp` gives concurrent runs distinct sockets without
//   coordination; the directory is removed on `close()`.
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
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
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
   * remove the socket file and its per-run runtime directory from disk.
   * Idempotent. */
  close(): Promise<void>;
}

export interface StartRunnerMcpServerOptions {
  runId: string;
  onOutput?: OnOutputCallback;
  /** Directory the per-run socket directory is created under. Defaults to
   * `os.tmpdir()` (which honors `$TMPDIR`). Exposed for tests. */
  runtimeDir?: string;
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

/** Basename of the socket inside the per-run runtime directory. */
const SOCKET_BASENAME = "mcp.sock";

/**
 * Longest unix socket path the platform will bind, in bytes: the size of
 * `sockaddr_un.sun_path` (104 on macOS/BSD, 108 on Linux). Measured, not
 * inferred — macOS accepts exactly 104 and rejects 105 with EINVAL.
 */
export function maxSocketPathBytes(platform: NodeJS.Platform = process.platform): number {
  return platform === "darwin" || platform.endsWith("bsd") ? 104 : 108;
}

/** Thrown by `startRunnerMcpServer` when even the short runtime-dir socket
 * path would exceed the platform limit (e.g. a very deep `$TMPDIR`). */
export class SocketPathTooLongError extends Error {
  readonly socketPath: string;
  readonly limit: number;
  constructor(socketPath: string, limit: number) {
    super(
      `unix socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${limit}-byte platform limit: ${socketPath} (set TMPDIR to a shorter directory)`,
    );
    this.name = "SocketPathTooLongError";
    this.socketPath = socketPath;
    this.limit = limit;
  }
}

/**
 * Compute the per-run socket path template: `<runtimeDir>/<prefix>XXXXXX/mcp.sock`
 * where `XXXXXX` is what `mkdtemp` will fill in. Same byte length as the
 * real path, so it can be checked against the platform limit before
 * anything is created.
 */
function socketPathPrefix(runtimeDir: string, runId: string): string {
  return path.join(path.resolve(runtimeDir), `minifac-${runId.slice(0, 8)}-`);
}

/**
 * Start the per-run MCP server. Resolves once the socket is bound and ready
 * to accept connections. Rejects with `SocketPathTooLongError` before
 * touching the filesystem if the socket path cannot fit `sun_path`, and
 * rejects (after removing the runtime directory) if the bind itself fails.
 */
export async function startRunnerMcpServer(
  opts: StartRunnerMcpServerOptions,
): Promise<RunnerMcpServer> {
  const prefix = socketPathPrefix(opts.runtimeDir ?? tmpdir(), opts.runId);
  const limit = maxSocketPathBytes();
  const candidate = path.join(`${prefix}XXXXXX`, SOCKET_BASENAME);
  if (Buffer.byteLength(candidate) > limit) {
    throw new SocketPathTooLongError(candidate, limit);
  }

  // Fresh per-run directory: no stale-socket reclaim needed, and concurrent
  // runs (even with the same run-id prefix) never collide.
  const runtimeDir = await mkdtemp(prefix);
  const socketPath = path.join(runtimeDir, SOCKET_BASENAME);

  const registrations = new Map<string, NodeRegistration>();
  const connections = new Set<ActiveConnection>();
  let closed = false;

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

  try {
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
  } catch (err) {
    await rm(runtimeDir, { recursive: true, force: true });
    throw err;
  }

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
      // Removes the socket file and its per-run directory together.
      await rm(runtimeDir, { recursive: true, force: true });
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
