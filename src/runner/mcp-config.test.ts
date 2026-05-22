import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMcpWrapperPath, writeMcpConfig } from "./mcp-config.js";

describe("writeMcpConfig", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "minfc-cfg-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("emits a .mcp.json wired to the per-run socket via the stdio wrapper", async () => {
    const socketPath = "/tmp/abc.mcp.sock";
    const wrapperPath = "/some/dist/runner/mcp-stdio-wrapper.js";
    const out = await writeMcpConfig({
      outputsDir: tmp,
      socketPath,
      wrapperPath,
    });
    expect(out).toBe(path.join(tmp, ".mcp.json"));
    const body = JSON.parse(await readFile(out, "utf8"));
    expect(body).toEqual({
      mcpServers: {
        minifac: {
          type: "stdio",
          command: "node",
          args: [wrapperPath, socketPath],
        },
      },
    });
  });

  it("respects an override `nodeBinary` for the command", async () => {
    const out = await writeMcpConfig({
      outputsDir: tmp,
      socketPath: "/tmp/x.sock",
      wrapperPath: "/w.js",
      nodeBinary: "/opt/node",
    });
    const body = JSON.parse(await readFile(out, "utf8"));
    expect(body.mcpServers.minifac.command).toBe("/opt/node");
  });

  it("defaults wrapperPath to a sibling of mcp-config", () => {
    const p = defaultMcpWrapperPath();
    // Same dir as the resolved mcp-config; ends with mcp-stdio-wrapper.{ts,js}
    expect(/mcp-stdio-wrapper\.(t|j)s$/.test(p)).toBe(true);
  });
});
