// `.mcp.json` emission for the per-dispatch Claude executor handoff.
//
// The runner emits one `.mcp.json` per Claude-executor dispatch into the
// per-node outputs directory. The file points the Claude CLI at minifac's
// per-run MCP server via a tiny stdio wrapper (`mcp-stdio-wrapper.ts`) so
// the SDK's stdio transport on the client side talks to our unix socket on
// the server side. The file is removed at run termination — its lifetime
// is "this run only".
//
// See `openspec/specs/graph-runner/spec.md` ("Per-dispatch `.mcp.json`
// config emission") and `openspec/changes/node-outputs-mcp/design.md` D5.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the on-disk path to the bundled stdio wrapper. At runtime we live
 * in either `src/runner/` (tests via Vitest) or `dist/runner/` (built); in
 * both layouts the wrapper sits next to this file under the same name.
 *
 * We resolve to the `.js` form when running compiled, and prefer that path
 * for `.mcp.json` so the `node` command can execute it directly. When
 * running from source (`src/runner/mcp-config.ts`), the sibling
 * `mcp-stdio-wrapper.ts` is what's available; we point `node` at that and
 * rely on tsx/loader behavior — in practice end-to-end tests use the
 * compiled output, and src-layout invocation is only exercised by unit
 * tests that don't spawn the wrapper.
 */
export function defaultMcpWrapperPath(): string {
  // import.meta.url is e.g. file:///.../src/runner/mcp-config.ts
  // or            file:///.../dist/runner/mcp-config.js
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  const ext = path.extname(here);
  // Prefer the sibling with the same extension as this file.
  return path.join(dir, `mcp-stdio-wrapper${ext}`);
}

export interface WriteMcpConfigOptions {
  /** Absolute path to the per-node outputs directory. The function writes
   * `<outputsDir>/.mcp.json`. */
  outputsDir: string;
  /** Absolute path to the unix socket the per-run MCP server is bound to. */
  socketPath: string;
  /** Optional override of the stdio wrapper. Defaults to the bundled
   * `mcp-stdio-wrapper` sibling resolved via `defaultMcpWrapperPath()`. */
  wrapperPath?: string;
  /** Optional override of the `node` binary used to spawn the wrapper. */
  nodeBinary?: string;
}

/**
 * Emit `<outputsDir>/.mcp.json` configured to talk to the per-run MCP
 * server's unix socket via the stdio wrapper. Returns the absolute path of
 * the written file so the caller can pass it via `--mcp-config`.
 */
export async function writeMcpConfig(opts: WriteMcpConfigOptions): Promise<string> {
  const wrapper = path.resolve(opts.wrapperPath ?? defaultMcpWrapperPath());
  const configPath = path.join(opts.outputsDir, ".mcp.json");
  const body = {
    mcpServers: {
      minifac: {
        type: "stdio",
        command: opts.nodeBinary ?? "node",
        args: [wrapper, opts.socketPath],
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(body, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return configPath;
}
