import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SqliteRunStore } from "../storage/sqlite.js";
import { briefsAction } from "./briefs.js";

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

async function makeRepo(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "minifac-briefs-cli-"));
}

async function freshStore(): Promise<SqliteRunStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-briefs-db-"));
  return SqliteRunStore.open(path.join(dir, "runs.db"));
}

async function writeBrief(
  repo: string,
  loc: "active" | "done",
  change: string,
  depends_on: string[] = [],
): Promise<void> {
  const sub = loc === "active" ? "inputs" : path.join("inputs", "done");
  await mkdir(path.join(repo, sub), { recursive: true });
  const deps =
    depends_on.length === 0 ? "" : `depends_on:\n${depends_on.map((d) => `  - ${d}`).join("\n")}\n`;
  await writeFile(
    path.join(repo, sub, `${change}.md`),
    `---\nchange: ${change}\nfactory: sdd\n${deps}---\nbody\n`,
    "utf8",
  );
}

describe("briefsAction", () => {
  it("lists active and done briefs sorted by change", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "bar");
    await writeBrief(repo, "done", "baz");
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      const text = out.text();
      expect(text.indexOf("bar")).toBeLessThan(text.indexOf("baz"));
      expect(text.indexOf("baz")).toBeLessThan(text.indexOf("foo"));
    } finally {
      await store.close();
    }
  });

  it("--state active filters out done", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "done", "baz");
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        state: "active",
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      const text = out.text();
      expect(text).toMatch(/foo/);
      expect(text).not.toMatch(/baz/);
    } finally {
      await store.close();
    }
  });

  it("--state rejects bad value", async () => {
    const repo = await makeRepo();
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        state: "wat",
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(1);
      expect(err.text()).toMatch(/active.*done.*missing/);
    } finally {
      await store.close();
    }
  });

  it("--activity running keeps only briefs with a running run", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "bar");
    const store = await freshStore();
    try {
      await store.createRun({
        id: "r1",
        factoryPath: "/p",
        factoryName: "sdd",
        change: "foo",
        startedAt: 10,
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        activity: "running",
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      const text = out.text();
      expect(text).toMatch(/foo/);
      expect(text).not.toMatch(/\bbar\b/);
    } finally {
      await store.close();
    }
  });

  it("--ready excludes blocked briefs (unsatisfied deps)", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo", ["bar"]);
    await writeBrief(repo, "active", "bar");
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        ready: true,
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      const text = out.text();
      expect(text).not.toMatch(/\bfoo\b/);
      // bar has no deps and no run → ready
      expect(text).toMatch(/\bbar\b/);
    } finally {
      await store.close();
    }
  });

  it("--ready excludes briefs with an in-flight run", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      await store.createRun({
        id: "r1",
        factoryPath: "/p",
        factoryName: "sdd",
        change: "foo",
        startedAt: 10,
      });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        ready: true,
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).not.toMatch(/\bfoo\b/);
    } finally {
      await store.close();
    }
  });

  it("--ready includes briefs whose last run failed", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      await store.createRun({
        id: "r1",
        factoryPath: "/p",
        factoryName: "sdd",
        change: "foo",
        startedAt: 10,
      });
      await store.finalizeRun("r1", { status: "failed", endedAt: 20 });
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        ready: true,
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/\bfoo\b/);
    } finally {
      await store.close();
    }
  });

  it("--json emits a stable sorted array", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo", ["bar"]);
    await writeBrief(repo, "done", "baz");
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        json: true,
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(out.text());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(2);
      expect(parsed[0].change).toBe("baz");
      expect(parsed[1].change).toBe("foo");
      // shape check
      expect(parsed[1]).toHaveProperty("state");
      expect(parsed[1]).toHaveProperty("activity");
      expect(parsed[1]).toHaveProperty("deps");
      expect(parsed[1]).toHaveProperty("deps_summary");
      expect(parsed[1]).toHaveProperty("last_run");
      expect(parsed[1].last_run).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("--inputs overrides the default inputs path", async () => {
    const repo = await makeRepo();
    const otherDir = await mkdtemp(path.join(tmpdir(), "minifac-briefs-other-"));
    await mkdir(otherDir, { recursive: true });
    await writeFile(
      path.join(otherDir, "from-other.md"),
      "---\nchange: from-other\nfactory: sdd\n---\nbody\n",
    );
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        inputs: otherDir,
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/from-other/);
    } finally {
      await store.close();
    }
  });

  it("reports parse_error activity for malformed brief", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, "inputs"), { recursive: true });
    await writeFile(path.join(repo, "inputs", "broken.md"), "no frontmatter at all", "utf8");
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/broken/);
      expect(out.text()).toMatch(/parse_error/);
    } finally {
      await store.close();
    }
  });

  it("empty inputs dir exits 0", async () => {
    const repo = await makeRepo();
    const store = await freshStore();
    try {
      const out = new BufferStream();
      const err = new BufferStream();
      const code = await briefsAction({
        store,
        cwd: repo,
        io: { stdout: out, stderr: err },
      });
      expect(code).toBe(0);
    } finally {
      await store.close();
    }
  });
});
