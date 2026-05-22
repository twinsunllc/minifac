#!/usr/bin/env node
// Tiny stdio↔unix-socket bridge for Claude Code's MCP client config.
//
// Claude Code's `.mcp.json` spawns a stdio-MCP server as a child process and
// pipes JSON-RPC messages over its stdin/stdout. minifac's per-run MCP server
// binds a unix socket. This wrapper bridges the two: read this process's
// stdin → write to the socket; read from the socket → write to this
// process's stdout. Exits cleanly when either end closes.
//
// Usage:
//   node mcp-stdio-wrapper.js <socket-path>

import * as net from "node:net";
import process from "node:process";

const socketPath = process.argv[2];
if (!socketPath) {
  process.stderr.write("minifac-mcp-stdio-wrapper: missing <socket-path> argument\n");
  process.exit(2);
}

const socket = net.createConnection(socketPath);

socket.on("error", (err) => {
  process.stderr.write(
    `minifac-mcp-stdio-wrapper: socket error: ${(err as Error).message}\n`,
  );
  process.exit(1);
});

socket.on("connect", () => {
  // Bridge stdin → socket. End-of-stdin should also end the socket.
  process.stdin.pipe(socket);
  // Bridge socket → stdout. Don't end stdout when socket ends (Node closes
  // the process naturally as both halves drain).
  socket.pipe(process.stdout, { end: false });
});

socket.on("close", () => {
  process.exit(0);
});
