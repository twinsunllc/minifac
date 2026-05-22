import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SqliteRunStore } from "../storage/sqlite.js";
import { listAction, showAction } from "./runs.js";

class BufferStream extends Writable {
  chunks: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: Writable callback shape uses any internally
  _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

async function freshStore(): Promise<SqliteRunStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-runs-"));
  return SqliteRunStore.open(path.join(dir, "runs.db"));
}

async function seed(store: SqliteRunStore): Promise<void> {
  await store.createRun({
    id: "aaaa1111-2222-3333-4444-555555555555",
    factoryPath: "/p/a.yaml",
    factoryName: "alpha",
    change: "feat-a",
    startedAt: 1000,
  });
  await store.appendEvent("aaaa1111-2222-3333-4444-555555555555", {
    nodeId: "n1",
    iteration: 1,
    kind: "stdout",
    payload: { kind: "stdout", line: "hello" },
    emittedAt: 5,
  });
  await store.appendEvent("aaaa1111-2222-3333-4444-555555555555", {
    nodeId: "n1",
    iteration: 1,
    kind: "status",
    payload: { kind: "status", status: "succeeded" },
    emittedAt: 6,
  });
  await store.finalizeRun("aaaa1111-2222-3333-4444-555555555555", {
    status: "succeeded",
    reason: "terminal_node_succeeded",
    endedAt: 2000,
  });
  await store.createRun({
    id: "bbbb2222-3333-4444-5555-666666666666",
    factoryPath: "/p/b.yaml",
    factoryName: "beta",
    change: "feat-b",
    startedAt: 3000,
  });
  await store.finalizeRun("bbbb2222-3333-4444-5555-666666666666", {
    status: "failed",
    reason: "node_failed",
    endedAt: 4000,
  });
}

describe("minifac runs (listAction)", () => {
  it("lists recent runs in startedAt-desc order", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({ store, io: { stdout: out, stderr: err } });
      expect(code).toBe(0);
      const text = out.text();
      // bbbb (newer) appears before aaaa
      expect(text.indexOf("bbbb2222")).toBeLessThan(text.indexOf("aaaa1111"));
    } finally {
      await store.close();
    }
  });

  it("--factory filters by factoryName", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({
        factory: "alpha",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toContain("aaaa1111");
      expect(out.text()).not.toContain("bbbb2222");
    } finally {
      await store.close();
    }
  });

  it("--change filters by change", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({
        change: "feat-b",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toContain("bbbb2222");
      expect(out.text()).not.toContain("aaaa1111");
    } finally {
      await store.close();
    }
  });

  it("--status rejects bad values", async () => {
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({
        status: "wat",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/running, succeeded, failed/);
    } finally {
      await store.close();
    }
  });

  it("--limit rejects non-positive values", async () => {
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({
        limit: "0",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/positive integer/);
    } finally {
      await store.close();
    }
  });

  it("--json emits a JSON array", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({
        limit: "5",
        json: true,
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(out.text());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0].id).toBe("bbbb2222-3333-4444-5555-666666666666");
    } finally {
      await store.close();
    }
  });

  it("includes a branch column with null and non-null values", async () => {
    const store = await freshStore();
    try {
      await store.createRun({
        id: "br-with-1",
        factoryPath: "/p",
        factoryName: "f",
        change: "feat-1",
        branchName: "run/feat-1-abcdef",
        startedAt: 10,
      });
      await store.createRun({
        id: "br-null-1",
        factoryPath: "/p",
        factoryName: "f",
        change: "feat-2",
        startedAt: 20,
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({ store, io: { stdout: out, stderr: err } });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/BRANCH/);
      expect(out.text()).toMatch(/run\/feat-1-abcdef/);
      // Null renders as `-`.
      expect(out.text()).toMatch(/feat-2\s+.*?-\s/);
    } finally {
      await store.close();
    }
  });

  it("--json includes branchName per row", async () => {
    const store = await freshStore();
    try {
      await store.createRun({
        id: "br-with-2",
        factoryPath: "/p",
        factoryName: "f",
        change: "feat-3",
        branchName: "run/feat-3-bbbbbb",
        startedAt: 30,
      });
      await store.createRun({
        id: "br-null-2",
        factoryPath: "/p",
        factoryName: "f",
        change: "feat-4",
        startedAt: 40,
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({ json: true, store, io: { stdout: out, stderr: err } });
      expect(code).toBe(0);
      const parsed = JSON.parse(out.text()) as Array<{ id: string; branchName: string | null }>;
      const byId = new Map(parsed.map((r) => [r.id, r]));
      expect(byId.get("br-with-2")?.branchName).toBe("run/feat-3-bbbbbb");
      expect(byId.get("br-null-2")?.branchName).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("no matches exits 0 with an empty result", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await listAction({
        change: "nonexistent",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/no runs/);
    } finally {
      await store.close();
    }
  });
});

describe("minifac runs show <id> (showAction)", () => {
  it("prints the persisted event log by full id", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await showAction({
        idOrPrefix: "aaaa1111-2222-3333-4444-555555555555",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toContain("[n1] hello");
      expect(err.text()).toMatch(/\[run\] succeeded/);
    } finally {
      await store.close();
    }
  });

  it("resolves an unambiguous prefix", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await showAction({
        idOrPrefix: "aaaa",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toContain("[n1] hello");
    } finally {
      await store.close();
    }
  });

  it("rejects ambiguous prefix with both matching ids", async () => {
    const store = await freshStore();
    try {
      await store.createRun({
        id: "ambig-1",
        factoryPath: "/p",
        factoryName: "x",
        startedAt: 1,
      });
      await store.createRun({
        id: "ambig-2",
        factoryPath: "/p",
        factoryName: "x",
        startedAt: 2,
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await showAction({
        idOrPrefix: "ambig-",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toContain("ambig-1");
      expect(err.text()).toContain("ambig-2");
    } finally {
      await store.close();
    }
  });

  it("unknown id exits 1", async () => {
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await showAction({
        idOrPrefix: "deadbeef",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/No run matches/);
    } finally {
      await store.close();
    }
  });

  it("--follow against a terminal run exits without polling", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const start = Date.now();
      const code = await showAction({
        idOrPrefix: "aaaa",
        follow: true,
        pollMs: 5_000,
        store,
        io: { stdout: out, stderr: err },
      });
      const elapsed = Date.now() - start;
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(500);
    } finally {
      await store.close();
    }
  });

  it("--follow against a running run tails until terminal", async () => {
    const store = await freshStore();
    try {
      await store.createRun({
        id: "running-1",
        factoryPath: "/p",
        factoryName: "x",
        startedAt: 1,
      });
      await store.appendEvent("running-1", {
        nodeId: "n",
        iteration: 1,
        kind: "stdout",
        payload: { kind: "stdout", line: "buffered" },
        emittedAt: 1,
      });
      const out = new BufferStream();
      const err = new BufferStream();

      // Drive the run to terminal off the event loop.
      const driver = (async () => {
        await new Promise((r) => setTimeout(r, 30));
        await store.appendEvent("running-1", {
          nodeId: "n",
          iteration: 1,
          kind: "stdout",
          payload: { kind: "stdout", line: "later" },
          emittedAt: 2,
        });
        await store.finalizeRun("running-1", {
          status: "succeeded",
          reason: "terminal_node_succeeded",
          endedAt: 50,
        });
      })();

      const code = await showAction({
        idOrPrefix: "running-1",
        follow: true,
        pollMs: 10,
        maxPolls: 100,
        store,
        io: { stdout: out, stderr: err },
      });
      await driver;
      expect(code).toBe(0);
      expect(out.text()).toContain("[n] buffered");
      expect(out.text()).toContain("[n] later");
      expect(err.text()).toMatch(/\[run\] succeeded/);
    } finally {
      await store.close();
    }
  });

  it("--json emits NDJSON, one event per line", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await showAction({
        idOrPrefix: "aaaa",
        json: true,
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      const lines = out
        .text()
        .split("\n")
        .filter((l) => l.length > 0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      await store.close();
    }
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import { catAction, parseSelector, formatBytes } from "./runs.js";

async function seedOutputs(
  store: SqliteRunStore,
  runId: string,
  outputsRoot: string,
): Promise<void> {
  // Per-iteration directory layout matches the runtime's choice.
  const proposeDir = path.join(outputsRoot, runId, "propose", "1");
  await mkdir(proposeDir, { recursive: true });
  const findingsPath = path.join(proposeDir, "findings.json");
  await writeFile(findingsPath, JSON.stringify({ a: 1, b: 2 }));
  await store.recordNodeOutputs(runId, "propose", 1, {
    findings: {
      type: "value",
      path: findingsPath,
      size: 13,
      mtime: 1700000000000,
    },
  });
}

describe("formatBytes", () => {
  it("formats bytes/KB/MB", () => {
    expect(formatBytes(412)).toBe("412 B");
    expect(formatBytes(18 * 1024 + 200)).toMatch(/^[0-9]+\.[0-9] KB$/);
    expect(formatBytes(1.1 * 1024 * 1024)).toMatch(/^1\.1 MB$/);
  });
});

describe("parseSelector", () => {
  it("parses node/key", () => {
    const r = parseSelector("propose/findings");
    expect(r).toEqual({ nodeId: "propose", outputKey: "findings" });
  });
  it("parses node:iter/key", () => {
    const r = parseSelector("verify:2/results");
    expect(r).toEqual({ nodeId: "verify", iteration: 2, outputKey: "results" });
  });
  it("parses directory filename selector", () => {
    const r = parseSelector("verify/logs/run.log");
    expect(r).toEqual({ nodeId: "verify", outputKey: "logs", filename: "run.log" });
  });
  it("rejects malformed selector (no slash)", () => {
    expect("error" in (parseSelector("foo") as object)).toBe(true);
  });
  it("rejects invalid iteration", () => {
    expect("error" in (parseSelector("verify:abc/x") as object)).toBe(true);
  });
});

describe("runs show --outputs", () => {
  it("appends the outputs tree after the event log", async () => {
    const store = await freshStore();
    const outputsRoot = await mkdtemp(path.join(tmpdir(), "minifac-out-show-"));
    try {
      await seed(store);
      await seedOutputs(store, "aaaa1111-2222-3333-4444-555555555555", outputsRoot);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await showAction({
        idOrPrefix: "aaaa",
        outputs: true,
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      const text = out.text();
      expect(text).toContain("Outputs for run aaaa1111-2222-3333-4444-555555555555:");
      expect(text).toContain("propose (iter 1):");
      expect(text).toMatch(/findings \(value/);
    } finally {
      await store.close();
    }
  });

  it("prints (none) when no outputs recorded", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await showAction({
        idOrPrefix: "aaaa",
        outputs: true,
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/Outputs for run .+:\n {2}\(none\)/);
    } finally {
      await store.close();
    }
  });

  it("--outputs --json emits a trailing {type:outputs} line", async () => {
    const store = await freshStore();
    const outputsRoot = await mkdtemp(path.join(tmpdir(), "minifac-out-show-json-"));
    try {
      await seed(store);
      await seedOutputs(store, "aaaa1111-2222-3333-4444-555555555555", outputsRoot);
      const out = new BufferStream();
      const err = new BufferStream();
      await showAction({
        idOrPrefix: "aaaa",
        outputs: true,
        json: true,
        store,
        io: { stdout: out, stderr: err },
      });
      const lines = out.text().split("\n").filter((l) => l.length > 0);
      const last = JSON.parse(lines[lines.length - 1] as string);
      expect(last.type).toBe("outputs");
      expect(Array.isArray(last.rows)).toBe(true);
      expect(last.rows.length).toBe(1);
    } finally {
      await store.close();
    }
  });
});

describe("runs cat", () => {
  it("prints the raw value file contents", async () => {
    const store = await freshStore();
    const outputsRoot = await mkdtemp(path.join(tmpdir(), "minifac-out-cat-"));
    try {
      await seed(store);
      await seedOutputs(store, "aaaa1111-2222-3333-4444-555555555555", outputsRoot);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await catAction({
        idOrPrefix: "aaaa",
        selector: "propose/findings",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toBe(JSON.stringify({ a: 1, b: 2 }));
    } finally {
      await store.close();
    }
  });

  it("malformed selector exits 1", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await catAction({
        idOrPrefix: "aaaa",
        selector: "not-a-selector",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/Usage error/);
    } finally {
      await store.close();
    }
  });

  it("unknown node exits 1", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await catAction({
        idOrPrefix: "aaaa",
        selector: "nonexistent/findings",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/nonexistent/);
    } finally {
      await store.close();
    }
  });

  it("rejects `..` traversal in directory filename", async () => {
    const store = await freshStore();
    const outputsRoot = await mkdtemp(path.join(tmpdir(), "minifac-out-cat-trav-"));
    try {
      await seed(store);
      // Seed a directory output.
      const runId = "aaaa1111-2222-3333-4444-555555555555";
      const logsDir = path.join(outputsRoot, runId, "verify", "1", "logs");
      await mkdir(logsDir, { recursive: true });
      await writeFile(path.join(logsDir, "run.log"), "hello");
      await store.recordNodeOutputs(runId, "verify", 1, {
        logs: { type: "directory", path: logsDir, size: 5, mtime: 1 },
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await catAction({
        idOrPrefix: "aaaa",
        selector: "verify/logs/../etc/passwd",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/traversal/);
    } finally {
      await store.close();
    }
  });

  it("directory selector without filename lists files", async () => {
    const store = await freshStore();
    const outputsRoot = await mkdtemp(path.join(tmpdir(), "minifac-out-cat-dir-"));
    try {
      await seed(store);
      const runId = "aaaa1111-2222-3333-4444-555555555555";
      const logsDir = path.join(outputsRoot, runId, "verify", "1", "logs");
      await mkdir(logsDir, { recursive: true });
      await writeFile(path.join(logsDir, "a.log"), "aaaa");
      await writeFile(path.join(logsDir, "b.log"), "bbbb");
      await store.recordNodeOutputs(runId, "verify", 1, {
        logs: { type: "directory", path: logsDir, size: 8, mtime: 1 },
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await catAction({
        idOrPrefix: "aaaa",
        selector: "verify/logs",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toContain("a.log");
      expect(out.text()).toContain("b.log");
    } finally {
      await store.close();
    }
  });

  it("explicit iteration selector picks that iteration", async () => {
    const store = await freshStore();
    const outputsRoot = await mkdtemp(path.join(tmpdir(), "minifac-out-cat-iter-"));
    try {
      await seed(store);
      const runId = "aaaa1111-2222-3333-4444-555555555555";
      const dir1 = path.join(outputsRoot, runId, "verify", "1");
      const dir2 = path.join(outputsRoot, runId, "verify", "2");
      await mkdir(dir1, { recursive: true });
      await mkdir(dir2, { recursive: true });
      await writeFile(path.join(dir1, "results.json"), '"iter1"');
      await writeFile(path.join(dir2, "results.json"), '"iter2"');
      await store.recordNodeOutputs(runId, "verify", 1, {
        results: { type: "value", path: path.join(dir1, "results.json"), size: 7, mtime: 1 },
      });
      await store.recordNodeOutputs(runId, "verify", 2, {
        results: { type: "value", path: path.join(dir2, "results.json"), size: 7, mtime: 2 },
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await catAction({
        idOrPrefix: "aaaa",
        selector: "verify:1/results",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toBe('"iter1"');
    } finally {
      await store.close();
    }
  });

  it("missing on-disk file exits 1", async () => {
    const store = await freshStore();
    try {
      await seed(store);
      const runId = "aaaa1111-2222-3333-4444-555555555555";
      await store.recordNodeOutputs(runId, "propose", 1, {
        findings: {
          type: "value",
          path: "/nonexistent/findings.json",
          size: 0,
          mtime: 0,
        },
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await catAction({
        idOrPrefix: "aaaa",
        selector: "propose/findings",
        store,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/Could not read/);
    } finally {
      await store.close();
    }
  });
});
