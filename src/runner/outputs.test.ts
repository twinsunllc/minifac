import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FactoryNode } from "../factory/schema.js";
import { validateDeclaredOutputs } from "./outputs.js";

describe("validateDeclaredOutputs — transport-aware detail strings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minfc-val-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function nodeWithOutputs(outputs: NonNullable<FactoryNode["outputs"]>): FactoryNode {
    return { terminal: false, outputs };
  }

  it("absent required value output with MCP available mentions tool and fallback", async () => {
    const node = nodeWithOutputs({
      findings: { type: "value", required: true },
    });
    const res = await validateDeclaredOutputs(node, dir, { mcpAvailable: true });
    expect(res.missing).toEqual(["findings"]);
    expect(res.detail.findings).toMatch(/mcp__minifac__report_findings/);
    expect(res.detail.findings).toMatch(/findings\.json/);
  });

  it("absent required value output without MCP gives the plain detail", async () => {
    const node = nodeWithOutputs({
      findings: { type: "value", required: true },
    });
    const res = await validateDeclaredOutputs(node, dir, { mcpAvailable: false });
    expect(res.missing).toEqual(["findings"]);
    expect(res.detail.findings).not.toMatch(/mcp__minifac__/);
    expect(res.detail.findings).toMatch(/findings\.json/);
  });

  it("present value output is indexed regardless of transport hint", async () => {
    const node = nodeWithOutputs({
      findings: { type: "value", required: true },
    });
    await writeFile(path.join(dir, "findings.json"), JSON.stringify({ ok: 1 }));
    const res = await validateDeclaredOutputs(node, dir, { mcpAvailable: true });
    expect(res.missing).toEqual([]);
    expect(res.index.findings).toBeTruthy();
    expect(res.index.findings?.path).toBe(path.join(dir, "findings.json"));
  });

  it("orphan .tmp-* sibling files do not satisfy a value output", async () => {
    const node = nodeWithOutputs({
      findings: { type: "value", required: true },
    });
    await writeFile(path.join(dir, "findings.tmp-abc123.json"), "{}");
    const res = await validateDeclaredOutputs(node, dir, { mcpAvailable: true });
    expect(res.missing).toEqual(["findings"]);
    expect(res.index.findings).toBeUndefined();
  });

  it("mcpReported map suppresses the MCP-aware detail when key was reported", async () => {
    // This branch is exercised when MCP reported via callback but the file
    // is somehow gone (defensive — should never happen in practice). Just
    // confirm the detail string drops the un-called-tool annotation.
    const node = nodeWithOutputs({
      findings: { type: "value", required: true },
    });
    const reported = new Map<string, "mcp" | "fs">([["findings", "mcp"]]);
    const res = await validateDeclaredOutputs(node, dir, {
      mcpAvailable: true,
      mcpReported: reported,
    });
    expect(res.missing).toEqual(["findings"]);
    expect(res.detail.findings).not.toMatch(/mcp__minifac__/);
  });

  it("file and directory outputs are unaffected by mcpAvailable", async () => {
    const node = nodeWithOutputs({
      patch: { type: "file", filename: "patch.diff", required: true },
      logs: { type: "directory", required: true },
    });
    const res = await validateDeclaredOutputs(node, dir, { mcpAvailable: true });
    expect(res.missing.sort()).toEqual(["logs", "patch"]);
    for (const key of res.missing) {
      expect(res.detail[key]).not.toMatch(/mcp__minifac__/);
    }
  });
});
