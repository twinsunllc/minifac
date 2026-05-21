import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteRunStore } from "../storage/sqlite.js";
import { BriefCycleError, computeBriefState } from "./state.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-state-"));
  await mkdir(path.join(dir, "inputs", "done"), { recursive: true });
  return dir;
}

async function freshStore(): Promise<SqliteRunStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-state-db-"));
  return SqliteRunStore.open(path.join(dir, "runs.db"));
}

async function brief(
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

describe("computeBriefState", () => {
  it("returns unblocked when there are no deps", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const r = await computeBriefState("foo", {
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        runStore: store,
      });
      expect(r.doneness).toBe("active");
      expect(r.deps).toEqual([]);
      expect(r.blocked).toBe(false);
      expect(r.blockedReason).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("returns unblocked when all deps are done", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo", ["bar", "baz"]);
    await brief(repo, "done", "bar");
    await brief(repo, "done", "baz");
    const store = await freshStore();
    try {
      const r = await computeBriefState("foo", {
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        runStore: store,
      });
      expect(r.blocked).toBe(false);
      expect(r.deps.map((d) => d.doneness)).toEqual(["done", "done"]);
    } finally {
      await store.close();
    }
  });

  it("blocks when a dep is still active", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo", ["bar"]);
    await brief(repo, "active", "bar");
    const store = await freshStore();
    try {
      const r = await computeBriefState("foo", {
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        runStore: store,
      });
      expect(r.blocked).toBe(true);
      expect(r.deps).toEqual([{ change: "bar", doneness: "active" }]);
      expect(r.blockedReason).toMatch(/bar.*active/);
    } finally {
      await store.close();
    }
  });

  it("blocks when a dep is missing", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo", ["bar"]);
    const store = await freshStore();
    try {
      const r = await computeBriefState("foo", {
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        runStore: store,
      });
      expect(r.blocked).toBe(true);
      expect(r.deps).toEqual([{ change: "bar", doneness: "missing" }]);
      expect(r.blockedReason).toMatch(/bar.*missing/);
    } finally {
      await store.close();
    }
  });

  it("surfaces multiple unsatisfied deps in reason", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo", ["bar", "baz", "qux"]);
    await brief(repo, "active", "bar");
    await brief(repo, "done", "baz");
    const store = await freshStore();
    try {
      const r = await computeBriefState("foo", {
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        runStore: store,
      });
      expect(r.blocked).toBe(true);
      expect(r.blockedReason).toMatch(/bar/);
      expect(r.blockedReason).toMatch(/qux/);
      expect(r.blockedReason).not.toMatch(/baz/); // satisfied
    } finally {
      await store.close();
    }
  });

  it("does not transitively block: immediate dep done is enough", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo", ["bar"]);
    await brief(repo, "done", "bar", ["baz"]);
    await brief(repo, "active", "baz");
    const store = await freshStore();
    try {
      const r = await computeBriefState("foo", {
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        runStore: store,
      });
      expect(r.blocked).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("detects a self-loop", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo", ["foo"]);
    const store = await freshStore();
    try {
      await expect(
        computeBriefState("foo", {
          inputsDir: path.join(repo, "inputs"),
          repoRoot: repo,
          runStore: store,
        }),
      ).rejects.toBeInstanceOf(BriefCycleError);
    } finally {
      await store.close();
    }
  });

  it("detects a two-node cycle", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo", ["bar"]);
    await brief(repo, "active", "bar", ["foo"]);
    const store = await freshStore();
    try {
      try {
        await computeBriefState("foo", {
          inputsDir: path.join(repo, "inputs"),
          repoRoot: repo,
          runStore: store,
        });
        throw new Error("expected cycle error");
      } catch (err) {
        expect(err).toBeInstanceOf(BriefCycleError);
        const e = err as BriefCycleError;
        expect(e.cycle).toEqual(["foo", "bar", "foo"]);
      }
    } finally {
      await store.close();
    }
  });

  it("detects a three-node cycle", async () => {
    const repo = await makeRepo();
    await brief(repo, "active", "foo", ["bar"]);
    await brief(repo, "active", "bar", ["baz"]);
    await brief(repo, "active", "baz", ["foo"]);
    const store = await freshStore();
    try {
      try {
        await computeBriefState("foo", {
          inputsDir: path.join(repo, "inputs"),
          repoRoot: repo,
          runStore: store,
        });
        throw new Error("expected cycle error");
      } catch (err) {
        expect(err).toBeInstanceOf(BriefCycleError);
        const e = err as BriefCycleError;
        expect(e.cycle).toEqual(["foo", "bar", "baz", "foo"]);
      }
    } finally {
      await store.close();
    }
  });

  it("treats missing root brief as blocked", async () => {
    const repo = await makeRepo();
    const store = await freshStore();
    try {
      const r = await computeBriefState("ghost", {
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        runStore: store,
      });
      expect(r.doneness).toBe("missing");
      expect(r.blocked).toBe(true);
      expect(r.blockedReason).toMatch(/brief file not found/);
    } finally {
      await store.close();
    }
  });
});
