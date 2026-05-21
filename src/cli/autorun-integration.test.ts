import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode, RunContext } from "../executor/types.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import { autorunAction } from "./autorun.js";

class BufferStream extends Writable {
  chunks: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: stream signature
  _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
  lines(): string[] {
    return this.text()
      .split("\n")
      .filter((l) => l.length > 0);
  }
}

function shOrThrow(cwd: string, args: string[]): void {
  const res = spawnSync(args[0] as string, args.slice(1), { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${res.stderr}`);
  }
}

/** Fake executor: emits a `started` then `succeeded` status. */
class FakeExecutor implements NodeExecutor {
  readonly type = "fake";
  async *run(_node: ResolvedNode, _ctx: RunContext): AsyncIterable<NodeEvent> {
    yield { kind: "stdout", line: "fake hello" };
    yield { kind: "status", status: "started" };
    yield { kind: "status", status: "succeeded" };
  }
}

async function setupIntegrationRepo(): Promise<{ repo: string; storeDir: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "minifac-autorun-int-"));
  shOrThrow(repo, ["git", "init", "-q", "-b", "main"]);
  shOrThrow(repo, ["git", "config", "user.email", "test@example.com"]);
  shOrThrow(repo, ["git", "config", "user.name", "Test"]);
  shOrThrow(repo, ["git", "config", "commit.gpgsign", "false"]);
  shOrThrow(repo, ["git", "config", "core.hooksPath", "/dev/null"]);
  await writeFile(path.join(repo, "README.md"), "hi\n");
  shOrThrow(repo, ["git", "add", "."]);
  shOrThrow(repo, ["git", "commit", "-q", "-m", "init"]);

  // Place an example factory that uses the `fake` executor.
  await mkdir(path.join(repo, "examples"), { recursive: true });
  await writeFile(
    path.join(repo, "examples", "fake.yaml"),
    `name: fake-factory
brief: required
nodes:
  only:
    executor: fake
    terminal: true
    with:
      prompt: "noop"
edges: []
`,
    "utf8",
  );

  // Use a separate dir for store to avoid touching $HOME/.minifac.
  const storeDir = await mkdtemp(path.join(tmpdir(), "minifac-autorun-store-"));
  return { repo, storeDir };
}

async function writeBriefAndCommit(
  repo: string,
  change: string,
  opts: { depends_on?: string[] } = {},
): Promise<void> {
  await mkdir(path.join(repo, "inputs"), { recursive: true });
  const depends_on = opts.depends_on ?? [];
  const deps =
    depends_on.length === 0 ? "" : `depends_on:\n${depends_on.map((d) => `  - ${d}`).join("\n")}\n`;
  await writeFile(
    path.join(repo, "inputs", `${change}.md`),
    `---\nchange: ${change}\nfactory: fake\nmode: in-place\n${deps}---\nbody for ${change}\n`,
    "utf8",
  );
  shOrThrow(repo, ["git", "add", "."]);
  shOrThrow(repo, ["git", "commit", "-q", "-m", `add brief ${change}`]);
}

function buildRegistry(): ExecutorRegistry {
  const reg = new ExecutorRegistry();
  reg.register(new FakeExecutor());
  return reg;
}

let savedMinifacHome: string | undefined;

beforeEach(async () => {
  savedMinifacHome = process.env.MINIFAC_HOME;
  process.env.MINIFAC_HOME = await mkdtemp(path.join(tmpdir(), "minifac-home-"));
});

afterEach(() => {
  if (savedMinifacHome === undefined) {
    process.env.MINIFAC_HOME = undefined;
  } else {
    process.env.MINIFAC_HOME = savedMinifacHome;
  }
});

describe("autorun integration", () => {
  it("end-to-end: runs two ready briefs, records to runs.db, moves briefs to done/", async () => {
    const { repo, storeDir } = await setupIntegrationRepo();
    await writeBriefAndCommit(repo, "foo");
    await writeBriefAndCommit(repo, "bar");

    const storePath = path.join(storeDir, "runs.db");
    const out = new BufferStream();
    const err = new BufferStream();

    const code = await autorunAction({
      options: { once: true, maxConcurrent: 2, json: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      buildRegistry,
      openRunStore: async () => SqliteRunStore.open(storePath),
    });

    expect(code).toBe(0);

    // Briefs moved to inputs/done/ by the mark-done post-step.
    expect(existsSync(path.join(repo, "inputs", "foo.md"))).toBe(false);
    expect(existsSync(path.join(repo, "inputs", "bar.md"))).toBe(false);
    expect(existsSync(path.join(repo, "inputs", "done", "foo.md"))).toBe(true);
    expect(existsSync(path.join(repo, "inputs", "done", "bar.md"))).toBe(true);

    // runs.db has two rows.
    const store = SqliteRunStore.open(storePath);
    try {
      const rows = await store.listRuns({ limit: 50 });
      const changes = rows.map((r) => r.change).sort();
      expect(changes).toEqual(["bar", "foo"]);
      for (const row of rows) {
        expect(row.status).toBe("succeeded");
      }
    } finally {
      await store.close();
    }

    // JSON log contains started + completed events per change.
    const lines = out.lines().map((l) => JSON.parse(l));
    const started = lines
      .filter((l) => l.event === "started")
      .map((l) => l.change)
      .sort();
    const completed = lines
      .filter((l) => l.event === "completed" && l.status === "succeeded")
      .map((l) => l.change)
      .sort();
    expect(started).toEqual(["bar", "foo"]);
    expect(completed).toEqual(["bar", "foo"]);
  });

  it("dep-driven scheduling: blocked brief skipped first poll, picked up after dep is done", async () => {
    const { repo, storeDir } = await setupIntegrationRepo();
    // bar depends on foo; foo must run first.
    await writeBriefAndCommit(repo, "foo");
    await writeBriefAndCommit(repo, "bar", { depends_on: ["foo"] });

    const storePath = path.join(storeDir, "runs.db");
    const out1 = new BufferStream();
    const err1 = new BufferStream();

    const code1 = await autorunAction({
      options: { once: true, maxConcurrent: 2, json: true },
      cwd: repo,
      io: { stdout: out1, stderr: err1 },
      buildRegistry,
      openRunStore: async () => SqliteRunStore.open(storePath),
    });
    expect(code1).toBe(0);
    // First cycle: foo runs, bar skipped reason=blocked.
    const lines1 = out1.lines().map((l) => JSON.parse(l));
    const skipped1 = lines1.find((l) => l.event === "skipped" && l.change === "bar");
    expect(skipped1?.reason).toBe("blocked");
    expect(existsSync(path.join(repo, "inputs", "done", "foo.md"))).toBe(true);
    expect(existsSync(path.join(repo, "inputs", "bar.md"))).toBe(true);

    // Second cycle: foo is done, bar's dep satisfied → runs.
    const out2 = new BufferStream();
    const err2 = new BufferStream();
    const code2 = await autorunAction({
      options: { once: true, maxConcurrent: 2, json: true },
      cwd: repo,
      io: { stdout: out2, stderr: err2 },
      buildRegistry,
      openRunStore: async () => SqliteRunStore.open(storePath),
    });
    expect(code2).toBe(0);
    expect(existsSync(path.join(repo, "inputs", "done", "bar.md"))).toBe(true);
    expect(existsSync(path.join(repo, "inputs", "bar.md"))).toBe(false);

    const lines2 = out2.lines().map((l) => JSON.parse(l));
    const started2 = lines2.filter((l) => l.event === "started").map((l) => l.change);
    expect(started2).toEqual(["bar"]);
  });
});
