import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadFactory } from "../factory/loader.js";
import { initAction } from "./init.js";

function captureStreams() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on("data", (c) => stdoutChunks.push(c.toString()));
  stderr.on("data", (c) => stderrChunks.push(c.toString()));
  return {
    io: { stdout, stderr },
    stdout: stdoutChunks,
    stderr: stderrChunks,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("minifac init", () => {
  it("creates inputs/, .minifac/, and .minifac/factories/ with README on an empty dir", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "minifac-init-"));
    const { io, stdout } = captureStreams();
    const code = await initAction({ cwd, io });
    expect(code).toBe(0);
    expect(await exists(path.join(cwd, "inputs"))).toBe(true);
    expect(await exists(path.join(cwd, ".minifac"))).toBe(true);
    expect(await exists(path.join(cwd, ".minifac", "factories"))).toBe(true);
    expect(await exists(path.join(cwd, ".minifac", "factories", "README.md"))).toBe(true);
    expect(stdout.join("")).toMatch(/Created/);
  });

  it("is idempotent — second invocation creates nothing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "minifac-init-"));
    const first = captureStreams();
    await initAction({ cwd, io: first.io });
    const second = captureStreams();
    const code = await initAction({ cwd, io: second.io });
    expect(code).toBe(0);
    expect(second.stdout.join("")).toMatch(/already initialized/i);
  });

  it("fills in only missing pieces", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "minifac-init-"));
    await mkdir(path.join(cwd, "inputs"), { recursive: true });
    const sentinel = path.join(cwd, "inputs", "marker.txt");
    await writeFile(sentinel, "preserve me", "utf8");
    const { io } = captureStreams();
    const code = await initAction({ cwd, io });
    expect(code).toBe(0);
    expect(await readFile(sentinel, "utf8")).toBe("preserve me");
    expect(await exists(path.join(cwd, ".minifac", "factories"))).toBe(true);
  });

  it("--with-sdd writes a starter sdd.yaml that loads cleanly", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "minifac-init-"));
    // The starter `extends: minifac:sdd` resolves against the bundled
    // install-root `examples/sdd.yaml` — no test-local fixture needed.
    const { io } = captureStreams();
    const code = await initAction({ cwd, withSdd: true, io });
    expect(code).toBe(0);
    const sddPath = path.join(cwd, ".minifac", "factories", "sdd.yaml");
    expect(await exists(sddPath)).toBe(true);
    const contents = await readFile(sddPath, "utf8");
    expect(contents).toMatch(/extends:\s*["']?minifac:sdd["']?/);
    // Round-trip: file loads cleanly through loadFactory, picking up the
    // bundled `name: sdd` from the install-root base layer.
    const loaded = await loadFactory(sddPath, cwd);
    expect(loaded.factory.name).toBe("sdd");
  });

  it("--with-sdd does not overwrite an existing sdd.yaml", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "minifac-init-"));
    await mkdir(path.join(cwd, ".minifac", "factories"), { recursive: true });
    const sddPath = path.join(cwd, ".minifac", "factories", "sdd.yaml");
    const custom =
      "name: custom\nnodes:\n  a:\n    executor: claude\n    terminal: true\nedges: []\n";
    await writeFile(sddPath, custom, "utf8");
    const { io, stdout } = captureStreams();
    const code = await initAction({ cwd, withSdd: true, io });
    expect(code).toBe(0);
    expect(await readFile(sddPath, "utf8")).toBe(custom);
    expect(stdout.join("")).toMatch(/preserved/);
  });
});
