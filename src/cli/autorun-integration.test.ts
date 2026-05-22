import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
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

/** Fake executor that commits a unique stamp file into its run's cwd
 *  (worktree). The stamp name embeds a counter so multiple chained runs
 *  in the same repo produce distinct commits that merge cleanly. */
let stampCounter = 0;
class CommittingExecutor implements NodeExecutor {
  readonly type = "fake";
  async *run(_node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    const { writeFileSync } = await import("node:fs");
    stampCounter += 1;
    const fname = path.join(ctx.cwd, `stamp-${stampCounter}.txt`);
    writeFileSync(fname, `run ${stampCounter}\n`);
    shOrThrow(ctx.cwd, ["git", "add", "."]);
    shOrThrow(ctx.cwd, [
      "git",
      "-c",
      "user.email=fake@example.com",
      "-c",
      "user.name=Fake",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "-m",
      `stamp ${stampCounter} commit`,
    ]);
    yield { kind: "stdout", line: `committed in ${ctx.cwd}` };
    yield { kind: "status", status: "succeeded" };
  }
}

function buildCommitRegistry(): ExecutorRegistry {
  const reg = new ExecutorRegistry();
  reg.register(new CommittingExecutor());
  return reg;
}

/** Set up a repo with a worktree-mode brief factory ready to run. */
async function setupWorktreeRepo(): Promise<{ repo: string; storeDir: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "minifac-autorun-wt-"));
  shOrThrow(repo, ["git", "init", "-q", "-b", "main"]);
  shOrThrow(repo, ["git", "config", "user.email", "test@example.com"]);
  shOrThrow(repo, ["git", "config", "user.name", "Test"]);
  shOrThrow(repo, ["git", "config", "commit.gpgsign", "false"]);
  shOrThrow(repo, ["git", "config", "core.hooksPath", "/dev/null"]);
  await writeFile(path.join(repo, "README.md"), "hi\n");
  shOrThrow(repo, ["git", "add", "."]);
  shOrThrow(repo, ["git", "commit", "-q", "-m", "init"]);
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
  const storeDir = await mkdtemp(path.join(tmpdir(), "minifac-autorun-store-"));
  return { repo, storeDir };
}

/** Write a worktree-mode brief (no `mode: in-place`). */
async function writeWorktreeBrief(
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
    `---\nchange: ${change}\nfactory: fake\nbase_branch: main\n${deps}---\nbody for ${change}\n`,
    "utf8",
  );
  shOrThrow(repo, ["git", "add", "."]);
  shOrThrow(repo, ["git", "commit", "-q", "-m", `add brief ${change}`]);
}

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

  it("worktree-mode chain: A merges to main, then B's worktree contains A's commit", async () => {
    const { repo, storeDir } = await setupWorktreeRepo();
    await writeWorktreeBrief(repo, "alpha");
    await writeWorktreeBrief(repo, "beta", { depends_on: ["alpha"] });

    const storePath = path.join(storeDir, "runs.db");
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1, json: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      buildRegistry: buildCommitRegistry,
      openRunStore: async () => SqliteRunStore.open(storePath),
    });
    expect(code).toBe(0);

    // alpha completed and merged onto main → main HEAD has alpha-stamp.txt.
    const mainLog = spawnSync("git", ["log", "main", "--pretty=%s"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(mainLog.status).toBe(0);
    expect(mainLog.stdout).toMatch(/stamp \d+ commit/);
    // Main HEAD contains at least one of the stamp files.
    const lsMain = spawnSync("git", ["ls-tree", "--name-only", "main"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(lsMain.status).toBe(0);
    expect(lsMain.stdout).toMatch(/stamp-\d+\.txt/);

    // alpha's brief moved to inputs/done/.
    expect(existsSync(path.join(repo, "inputs", "alpha.md"))).toBe(false);
    expect(existsSync(path.join(repo, "inputs", "done", "alpha.md"))).toBe(true);

    // beta should have been blocked on this poll (alpha was scheduled and
    // ran serially under --max-concurrent 1, completing in the same loop;
    // the scheduler made the blocked decision against the still-active
    // brief). Run a second cycle now that alpha is done.
    const out2 = new BufferStream();
    const err2 = new BufferStream();
    const code2 = await autorunAction({
      options: { once: true, maxConcurrent: 1, json: true },
      cwd: repo,
      io: { stdout: out2, stderr: err2 },
      buildRegistry: buildCommitRegistry,
      openRunStore: async () => SqliteRunStore.open(storePath),
    });
    expect(code2).toBe(0);

    // beta now ran, was merged, and moved to done.
    expect(existsSync(path.join(repo, "inputs", "beta.md"))).toBe(false);
    expect(existsSync(path.join(repo, "inputs", "done", "beta.md"))).toBe(true);

    // beta's branch was based off main (which already had alpha's commit),
    // so beta's worktree HEAD ancestry includes alpha's commit subject.
    const mainLogFinal = spawnSync("git", ["log", "main", "--pretty=%s"], {
      cwd: repo,
      encoding: "utf8",
    });
    // main HEAD contains both alpha's and beta's stamp commits.
    const stampCommits = (mainLogFinal.stdout.match(/stamp \d+ commit/g) ?? []).length;
    expect(stampCommits).toBeGreaterThanOrEqual(2);
  });

  it("worktree-mode merge failure: brief stays put, B stays blocked, recovery via minifac merge A", async () => {
    const { repo, storeDir } = await setupWorktreeRepo();
    await writeWorktreeBrief(repo, "alpha");
    await writeWorktreeBrief(repo, "beta", { depends_on: ["alpha"] });

    // Dirty the caller's working tree (untracked file) so the auto-merge
    // step refuses with reason=dirty-working-tree. This is the simplest
    // deterministic failure mode that does not require coordinating
    // divergent commits with worktree creation timing.
    await writeFile(path.join(repo, "scratch.txt"), "uncommitted\n");

    const storePath = path.join(storeDir, "runs.db");
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1, json: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      buildRegistry: buildCommitRegistry,
      openRunStore: async () => SqliteRunStore.open(storePath),
    });
    expect(code).toBe(0);

    // alpha's factory succeeded but merge failed.
    const lines = out.lines().map((l) => JSON.parse(l));
    const failed = lines.find((l) => l.event === "auto-merge-failed" && l.change === "alpha");
    expect(failed).toBeDefined();
    expect(failed?.reason).toBe("dirty-working-tree");
    // alpha's brief stays put.
    expect(existsSync(path.join(repo, "inputs", "alpha.md"))).toBe(true);
    expect(existsSync(path.join(repo, "inputs", "done", "alpha.md"))).toBe(false);

    // beta should be skipped reason=blocked.
    const skipped = lines.find((l) => l.event === "skipped" && l.change === "beta");
    expect(skipped?.reason).toBe("blocked");

    // Recovery: clean up the dirty file, then run `minifac merge alpha`.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(path.join(repo, "scratch.txt"));
    const store = SqliteRunStore.open(storePath);
    try {
      const { runMerge } = await import("./merge.js");
      const out2 = new BufferStream();
      const err2 = new BufferStream();
      const mergeCode = await runMerge({
        arg: "alpha",
        store,
        cwd: repo,
        stdin: Readable.from([]),
        stdout: out2,
        stderr: err2,
      });
      expect(mergeCode).toBe(0);
    } finally {
      await store.close();
    }
    // alpha's brief now moved to done by the merge command's mark-done step.
    expect(existsSync(path.join(repo, "inputs", "alpha.md"))).toBe(false);
    expect(existsSync(path.join(repo, "inputs", "done", "alpha.md"))).toBe(true);

    // Next autorun cycle: beta is unblocked and runs.
    const out3 = new BufferStream();
    const err3 = new BufferStream();
    const code3 = await autorunAction({
      options: { once: true, maxConcurrent: 1, json: true },
      cwd: repo,
      io: { stdout: out3, stderr: err3 },
      buildRegistry: buildCommitRegistry,
      openRunStore: async () => SqliteRunStore.open(storePath),
    });
    expect(code3).toBe(0);
    const lines3 = out3.lines().map((l) => JSON.parse(l));
    const started3 = lines3.filter((l) => l.event === "started").map((l) => l.change);
    expect(started3).toContain("beta");
  });
});
