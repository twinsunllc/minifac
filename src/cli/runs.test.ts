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
