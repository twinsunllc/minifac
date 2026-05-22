import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installRoot } from "../packaging/install-root.js";
import { stepsAction } from "./steps.js";

async function makeRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "minifac-cli-steps-"));
}

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

interface BufStream {
  buf: string;
  isTTY?: boolean;
  columns?: number;
  write(s: string): boolean;
}

function makeIO(): {
  stdout: BufStream;
  stderr: BufStream;
} {
  const make = (): BufStream => ({
    buf: "",
    columns: 120,
    isTTY: false,
    write(s: string): boolean {
      this.buf += s;
      return true;
    },
  });
  return { stdout: make(), stderr: make() };
}

const STEP_A = `name: alpha
version: "1.0.0"
description: "the alpha step"
executor: claude
with: { prompt: hi }
`;

const STEP_B = `name: beta
version: "2.0.0"
description: "the beta step"
executor: claude
with: { prompt: hi }
`;

describe("stepsAction", () => {
  it("lists built-ins only when no local steps exist", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/alpha.yaml", STEP_A);
    const io = makeIO();
    const code = await stepsAction({
      cwd: repo,
      builtinDirOverride: path.join(repo, "examples", "steps"),
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    expect(io.stdout.buf).toContain("alpha");
    expect(io.stdout.buf).toContain("built-in");
    expect(io.stdout.buf).toContain("1.0.0");
  });

  it("filters with --source local", async () => {
    const repo = await makeRepo();
    await writeAt(repo, ".minifac/steps/alpha.yaml", STEP_A);
    await writeAt(repo, "examples/steps/beta.yaml", STEP_B);
    const io = makeIO();
    const code = await stepsAction({
      source: "local",
      cwd: repo,
      builtinDirOverride: path.join(repo, "examples", "steps"),
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    expect(io.stdout.buf).toContain("alpha");
    expect(io.stdout.buf).not.toContain("beta");
  });

  it("filters with --source built-in", async () => {
    const repo = await makeRepo();
    await writeAt(repo, ".minifac/steps/alpha.yaml", STEP_A);
    await writeAt(repo, "examples/steps/beta.yaml", STEP_B);
    const io = makeIO();
    const code = await stepsAction({
      source: "built-in",
      cwd: repo,
      builtinDirOverride: path.join(repo, "examples", "steps"),
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    expect(io.stdout.buf).toContain("beta");
    expect(io.stdout.buf).not.toContain("alpha");
  });

  it("--json emits a parseable JSON array", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/alpha.yaml", STEP_A);
    const io = makeIO();
    const code = await stepsAction({
      json: true,
      cwd: repo,
      builtinDirOverride: path.join(repo, "examples", "steps"),
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    const arr = JSON.parse(io.stdout.buf.trim());
    expect(Array.isArray(arr)).toBe(true);
    expect(arr[0]).toMatchObject({ name: "alpha", version: "1.0.0", source: "built-in" });
  });

  it("same-name local and built-in both appear in --source all", async () => {
    const repo = await makeRepo();
    await writeAt(repo, ".minifac/steps/alpha.yaml", STEP_A);
    await writeAt(repo, "examples/steps/alpha.yaml", STEP_A);
    const io = makeIO();
    const code = await stepsAction({
      source: "all",
      json: true,
      cwd: repo,
      builtinDirOverride: path.join(repo, "examples", "steps"),
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    const arr = JSON.parse(io.stdout.buf.trim());
    expect(arr.filter((r: { name: string }) => r.name === "alpha")).toHaveLength(2);
    const sources = arr.map((r: { source: string }) => r.source);
    expect(sources).toContain("local");
    expect(sources).toContain("built-in");
  });

  it("empty directories produce an empty-listing message", async () => {
    const repo = await makeRepo();
    const io = makeIO();
    const code = await stepsAction({
      cwd: repo,
      builtinDirOverride: path.join(repo, "examples", "steps"),
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    expect(io.stdout.buf).toContain("no steps");
  });

  it("malformed step file appears with an error placeholder", async () => {
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/broken.yaml", "this is not: { valid");
    const io = makeIO();
    const code = await stepsAction({
      json: true,
      cwd: repo,
      builtinDirOverride: path.join(repo, "examples", "steps"),
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    const arr = JSON.parse(io.stdout.buf.trim());
    expect(arr).toHaveLength(1);
    expect(arr[0].error).toBeTruthy();
  });

  it("unrecognized --source exits 1 and writes supported set to stderr", async () => {
    const repo = await makeRepo();
    const io = makeIO();
    const code = await stepsAction({
      source: "remote",
      cwd: repo,
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(1);
    expect(io.stderr.buf).toMatch(/local.*built-in.*all/);
  });

  it("--source built-in scans the install root by default and reports its path", async () => {
    const repo = await makeRepo();
    const io = makeIO();
    const code = await stepsAction({
      source: "built-in",
      json: true,
      cwd: repo,
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    const arr = JSON.parse(io.stdout.buf.trim());
    expect(arr.length).toBeGreaterThan(0);
    const expectedPrefix = path.join(installRoot(), "examples", "steps");
    for (const row of arr) {
      expect(row.source).toBe("built-in");
      expect(row.path.startsWith(expectedPrefix)).toBe(true);
    }
    // The bundled `openspec-apply` step should be visible.
    expect(arr.map((r: { name: string }) => r.name)).toContain("openspec-apply");
  });

  it("--source built-in falls back to <cwd>/examples/steps when install root is unavailable", async () => {
    // Simulate the install-root-unavailable case by pointing the override
    // at the cwd's examples/steps directory. The path reported in JSON
    // should match the directory actually scanned.
    const repo = await makeRepo();
    await writeAt(repo, "examples/steps/alpha.yaml", STEP_A);
    const io = makeIO();
    const overrideDir = path.join(repo, "examples", "steps");
    const code = await stepsAction({
      source: "built-in",
      json: true,
      cwd: repo,
      builtinDirOverride: overrideDir,
      io: {
        stdout: io.stdout as unknown as NodeJS.WritableStream & { isTTY?: boolean },
        stderr: io.stderr as unknown as NodeJS.WritableStream,
      },
    });
    expect(code).toBe(0);
    const arr = JSON.parse(io.stdout.buf.trim());
    expect(arr).toHaveLength(1);
    expect(arr[0].name).toBe("alpha");
    expect(arr[0].path.startsWith(overrideDir)).toBe(true);
  });
});
