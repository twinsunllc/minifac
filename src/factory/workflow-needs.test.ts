import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearLibraryMemo } from "../library/library.js";
import { FactoryLoadError, loadFactory } from "./loader.js";

// Workflow `needs:` (SCARIFW-2229, ADR 0049): accepted, carried, never
// inherited. The vocabulary is Scarif's to check, not minifac's.

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

const NODES = `nodes:
  build:
    executor: tool
    with: { command: "true" }
  ship:
    executor: tool
    terminal: true
    with: { command: "true" }
edges:
  - from: build
    to: ship
`;

let root: string;
let prevHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "minifac-workflow-needs-"));
  prevHome = process.env.MINIFAC_HOME;
  process.env.MINIFAC_HOME = path.join(root, "home");
  _clearLibraryMemo();
});

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "MINIFAC_HOME");
  else process.env.MINIFAC_HOME = prevHome;
});

async function loadError(file: string, cwd: string): Promise<FactoryLoadError> {
  try {
    await loadFactory(file, cwd);
  } catch (err) {
    if (err instanceof FactoryLoadError) return err;
    throw err;
  }
  throw new Error("expected loadFactory to fail");
}

describe("workflow `needs:` through loadFactory", () => {
  it("loads a list and carries it on the resolved factory", async () => {
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      `name: w\nneeds: [linux, android]\n${NODES}`,
    );
    const loaded = await loadFactory(file, root);
    expect(loaded.factory.needs).toEqual(["linux", "android"]);
  });

  it("leaves the key off a workflow that does not declare it", async () => {
    const file = await writeAt(root, ".minifac/factories/w.yaml", `name: w\n${NODES}`);
    const loaded = await loadFactory(file, root);
    expect("needs" in loaded.factory).toBe(false);
  });

  it("does not check tokens against Scarif's vocabulary", async () => {
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      `name: w\nneeds: [banana]\n${NODES}`,
    );
    const loaded = await loadFactory(file, root);
    expect(loaded.factory.needs).toEqual(["banana"]);
  });

  it.each([
    ["a scalar", "needs: linux", /Schema error at needs: .*list of capability tokens/],
    ["a map", "needs:\n  linux: true", /Schema error at needs: .*list of capability tokens/],
    [
      "an empty-string entry",
      `needs: [linux, ""]`,
      /Schema error at needs\.1: capability token must be a non-empty string/,
    ],
    [
      "a blank entry",
      `needs: ["  "]`,
      /Schema error at needs\.0: capability token must be a non-empty string/,
    ],
    ["a non-string entry", "needs: [linux, 7]", /Schema error at needs\.1: /],
    [
      "a duplicate entry",
      "needs: [linux, linux]",
      /Schema error at needs\.1: duplicate capability token "linux"/,
    ],
  ])("refuses %s, naming the workflow file and the key", async (_label, yaml, message) => {
    const file = await writeAt(root, ".minifac/factories/w.yaml", `name: w\n${yaml}\n${NODES}`);
    const err = await loadError(file, root);
    expect(err.sourcePath).toBe(file);
    expect(err.message).toMatch(message);
  });

  it("still refuses another unknown top-level key", async () => {
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      `name: w\nneeds: [linux]\nroute: linux\n${NODES}`,
    );
    const err = await loadError(file, root);
    expect(err.message).toMatch(/Unrecognized key.*route/);
  });
});

describe("`needs:` is not inherited through `extends:`", () => {
  async function base(needs: string): Promise<void> {
    await writeAt(root, ".minifac/factories/base.yaml", `name: base\n${needs}${NODES}`);
  }

  it("a derived workflow's own list loads with `extends:`", async () => {
    await base("");
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      "extends: base\nneeds: [linux]\n",
    );
    const loaded = await loadFactory(file, root);
    expect(loaded.factory.needs).toEqual(["linux"]);
    expect(loaded.factory.name).toBe("base");
  });

  it("a base's list does not reach a derived workflow that omits the key", async () => {
    await base("needs: [linux, android]\n");
    const file = await writeAt(root, ".minifac/factories/w.yaml", "extends: base\n");
    const loaded = await loadFactory(file, root);
    expect("needs" in loaded.factory).toBe(false);
  });

  it("a derived list replaces the base's and is never merged with it", async () => {
    await base("needs: [linux]\n");
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      "extends: base\nneeds: [android]\n",
    );
    const loaded = await loadFactory(file, root);
    expect(loaded.factory.needs).toEqual(["android"]);
  });
});
