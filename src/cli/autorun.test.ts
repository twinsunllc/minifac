import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { StoredRun } from "../storage/run-store.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import type { AutorunRunFactory, RunFactoryResult } from "./autorun-scheduler.js";
import { autorunAction } from "./autorun.js";
import type { MergeOutcome } from "./merge.js";

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

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-autorun-"));
  await mkdir(path.join(dir, "inputs"), { recursive: true });
  return dir;
}

async function freshStore(): Promise<SqliteRunStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-autorun-db-"));
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

interface RunFactoryRecorder {
  factory: AutorunRunFactory;
  calls: string[];
  killSignals: NodeJS.Signals[];
  /** controls which call resolves on next tick */
  resolveLatest: (result?: RunFactoryResult) => void;
  pendingCount: () => number;
}

function makeRecorder(autoResolve = true): RunFactoryRecorder {
  const calls: string[] = [];
  const killSignals: NodeJS.Signals[] = [];
  const pending: Array<{ resolve: (r: RunFactoryResult) => void }> = [];
  const factory: AutorunRunFactory = (args) => {
    calls.push(args.brief.frontmatter.change);
    let resolveFn: (r: RunFactoryResult) => void = () => undefined;
    const promise = new Promise<RunFactoryResult>((res) => {
      resolveFn = res;
    });
    if (autoResolve) {
      queueMicrotask(() => resolveFn({ status: "succeeded", runId: `run-${calls.length}` }));
    } else {
      pending.push({ resolve: resolveFn });
    }
    return {
      promise,
      child: {
        kill(signal?: NodeJS.Signals) {
          killSignals.push(signal ?? "SIGTERM");
        },
      },
    };
  };
  return {
    factory,
    calls,
    killSignals,
    resolveLatest(result) {
      const last = pending.shift();
      if (!last) throw new Error("no pending run to resolve");
      last.resolve(result ?? { status: "succeeded" });
    },
    pendingCount: () => pending.length,
  };
}

describe("autorunAction", () => {
  it("--once schedules ready briefs (up to --max-concurrent), drains, and resolves", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "bar");
    await writeBrief(repo, "active", "baz");
    const store = await freshStore();
    const rec = makeRecorder(false);
    const out = new BufferStream();
    const err = new BufferStream();
    const codePromise = autorunAction({
      options: { maxConcurrent: 2, once: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
    });
    // Wait for pollOnce to complete enqueueing decisions. setImmediate
    // polling is too tight for the CI runner; use real time with a
    // 2-second cap so the test still fails fast if the logic is wrong.
    {
      const deadline = Date.now() + 2000;
      while (rec.pendingCount() < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    expect(rec.calls).toHaveLength(2);
    rec.resolveLatest({ status: "succeeded", runId: "run-1" });
    rec.resolveLatest({ status: "succeeded", runId: "run-2" });
    const code = await codePromise;
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toMatch(/started/);
    expect(text).toMatch(/skipped baz reason=concurrency/);
  });

  it("emits skipped reason=blocked for blocked briefs", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo", ["bar"]);
    await writeBrief(repo, "active", "bar"); // bar exists but is active, not done
    const store = await freshStore();
    const rec = makeRecorder();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 2 },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
    });
    expect(code).toBe(0);
    expect(rec.calls).toContain("bar");
    expect(rec.calls).not.toContain("foo");
    expect(out.text()).toMatch(/skipped foo reason=blocked/);
  });

  it("emits skipped reason=filtered for briefs filtered out", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "feat-a");
    await writeBrief(repo, "active", "chore-b");
    const store = await freshStore();
    const rec = makeRecorder();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 2, filter: "feat-*" },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
    });
    expect(code).toBe(0);
    expect(rec.calls).toEqual(["feat-a"]);
    expect(out.text()).toMatch(/skipped chore-b reason=filtered/);
  });

  it("--dry-run emits dry-run-decision events and does NOT invoke runFactory", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "bar", ["baz"]); // baz missing → blocked
    const store = await freshStore();
    const rec = makeRecorder();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { dryRun: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
    });
    expect(code).toBe(0);
    expect(rec.calls).toHaveLength(0);
    const text = out.text();
    expect(text).toMatch(/dry-run-decision foo action=schedule/);
    expect(text).toMatch(/dry-run-decision bar action=skip reason=blocked/);
  });

  it("SIGINT during a long-running session lets in-flight runs resolve", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    const rec = makeRecorder(false); // manual resolution
    const out = new BufferStream();
    const err = new BufferStream();
    let signalHandler: (() => void) | undefined;
    const codePromise = autorunAction({
      options: { interval: 1, maxConcurrent: 1 },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
      installSignalHandlers: ({ onSignal }) => {
        signalHandler = onSignal;
        return () => {
          signalHandler = undefined;
        };
      },
    });
    // Yield until the first run is in flight.
    for (let i = 0; i < 20 && rec.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.calls).toEqual(["foo"]);
    expect(rec.pendingCount()).toBe(1);
    signalHandler?.();
    // No additional briefs are added, but verify polls stop scheduling new runs by
    // adding a second brief and confirming no schedule happens after the signal.
    await writeBrief(repo, "active", "bar");
    // Resolve in-flight so drain completes.
    rec.resolveLatest({ status: "succeeded", runId: "run-1" });
    const code = await codePromise;
    expect(code).toBe(0);
    expect(rec.calls).toEqual(["foo"]); // bar never scheduled
  });

  it("second SIGINT calls killAllInFlight and returns escalated exit code", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    const rec = makeRecorder(false);
    const out = new BufferStream();
    const err = new BufferStream();
    let signalHandler: (() => void) | undefined;
    const codePromise = autorunAction({
      options: { interval: 1, maxConcurrent: 1 },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
      installSignalHandlers: ({ onSignal }) => {
        signalHandler = onSignal;
        return () => {
          signalHandler = undefined;
        };
      },
    });
    for (let i = 0; i < 20 && rec.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.calls).toEqual(["foo"]);
    signalHandler?.();
    signalHandler?.();
    expect(rec.killSignals).toEqual(["SIGTERM"]);
    rec.resolveLatest({ status: "failed", reason: "killed" });
    const code = await codePromise;
    expect(code).toBe(2);
  });

  it("--force escalates on first signal", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    const rec = makeRecorder(false);
    const out = new BufferStream();
    const err = new BufferStream();
    let signalHandler: (() => void) | undefined;
    const codePromise = autorunAction({
      options: { interval: 1, maxConcurrent: 1, force: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
      installSignalHandlers: ({ onSignal }) => {
        signalHandler = onSignal;
        return () => {
          signalHandler = undefined;
        };
      },
    });
    for (let i = 0; i < 20 && rec.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.calls).toEqual(["foo"]);
    signalHandler?.();
    expect(rec.killSignals).toEqual(["SIGTERM"]);
    rec.resolveLatest({ status: "failed", reason: "killed" });
    const code = await codePromise;
    expect(code).toBe(2);
  });

  it('--filter "feat-*" schedules only the matching subset', async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "feat-a");
    await writeBrief(repo, "active", "feat-b");
    await writeBrief(repo, "active", "chore-c");
    const store = await freshStore();
    const rec = makeRecorder();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 5, filter: "feat-*" },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
    });
    expect(code).toBe(0);
    expect(new Set(rec.calls)).toEqual(new Set(["feat-a", "feat-b"]));
  });

  it("--filter regex form matches only the exact name", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "foobar");
    const store = await freshStore();
    const rec = makeRecorder();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 5, filter: "/^foo$/" },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
    });
    expect(code).toBe(0);
    expect(rec.calls).toEqual(["foo"]);
  });

  it("an unparseable brief in inputs/ does NOT abort the poll cycle", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    // Unparseable brief: missing frontmatter fence
    await writeFile(path.join(repo, "inputs", "bad.md"), "not a brief at all\n", "utf8");
    const store = await freshStore();
    const rec = makeRecorder();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 5 },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
    });
    expect(code).toBe(0);
    expect(rec.calls).toEqual(["foo"]);
    expect(err.text()).toMatch(/skipping unparseable brief/);
  });

  it("rejects --max-concurrent 0 as a usage error", async () => {
    const repo = await makeRepo();
    const store = await freshStore();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { maxConcurrent: 0, once: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
      openRunStore: async () => store,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--max-concurrent/);
    await store.close();
  });

  it("rejects --interval -1 as a usage error", async () => {
    const repo = await makeRepo();
    const store = await freshStore();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { interval: -1, once: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
      openRunStore: async () => store,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--interval/);
    await store.close();
  });

  it("rejects invalid --filter regex as a usage error", async () => {
    const repo = await makeRepo();
    const store = await freshStore();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { filter: "/[unterminated/", once: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
      openRunStore: async () => store,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--filter/);
    await store.close();
  });

  it("missing --watch dir is a usage error", async () => {
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { watch: "/definitely/nonexistent/path/here", once: true },
      cwd: "/tmp",
      io: { stdout: out, stderr: err },
      runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
      openRunStore: async () => await freshStore(),
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--watch/);
  });

  it("--json mode emits one JSON object per line", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    const rec = makeRecorder();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, json: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: rec.factory,
      openRunStore: async () => store,
    });
    expect(code).toBe(0);
    const lines = out.lines().map((l) => JSON.parse(l));
    const kinds = lines.map((l) => l.event);
    expect(kinds).toContain("startup");
    expect(kinds).toContain("poll-start");
    expect(kinds).toContain("started");
    expect(kinds).toContain("completed");
    const completed = lines.find((l) => l.event === "completed");
    expect(completed.status).toBe("succeeded");
    expect(completed.change).toBe("foo");
  });
});

describe("autorunAction auto-merge step", () => {
  /** Seed a run row in the store so `store.getRun(runId)` returns one with
   *  a non-null branchName (so performAutoMerge proceeds to mergeRun). */
  async function seedRunRow(
    store: SqliteRunStore,
    runId: string,
    change: string,
    overrides: Partial<StoredRun> = {},
  ): Promise<void> {
    const startedAt = overrides.startedAt ?? Date.now();
    await store.createRun({
      id: runId,
      factoryPath: overrides.factoryPath ?? "/p/f.yaml",
      factoryName: overrides.factoryName ?? "f",
      ...(overrides.briefPath !== undefined ? { briefPath: overrides.briefPath } : {}),
      change,
      ...(overrides.baseBranch !== undefined ? { baseBranch: overrides.baseBranch } : {}),
      ...(overrides.worktreePath !== undefined ? { worktreePath: overrides.worktreePath } : {}),
      ...(overrides.branchName !== undefined
        ? { branchName: overrides.branchName }
        : { branchName: `run/${change}-aaaaaa` }),
      startedAt,
    });
    await store.finalizeRun(runId, {
      status: overrides.status ?? "succeeded",
      ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
      ...(overrides.proximateNodeId !== undefined
        ? { proximateNodeId: overrides.proximateNodeId }
        : {}),
      endedAt: overrides.endedAt ?? startedAt + 1,
    });
  }

  it("success path: mergeRun called, mark-done called, no auto-merge-failed event", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    let nextRunId = 1;
    const factory: AutorunRunFactory = (args) => {
      const runId = `run-${nextRunId++}`;
      const promise = (async () => {
        // Pre-seed the run row with a branch name so performAutoMerge
        // sees something to merge.
        await seedRunRow(store, runId, args.brief.frontmatter.change, {
          branchName: "run/foo-111111",
          worktreePath: "/wt/foo",
        });
        return { status: "succeeded" as const, runId };
      })();
      return { promise };
    };
    const merges: Array<{ row: StoredRun }> = [];
    const marks: Array<{ change: string; runCwd: string }> = [];
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1 },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      mergeRunFn: async (row) => {
        merges.push({ row });
        return {
          ok: true,
          headSha: "deadbeef",
          defaultBranch: "main",
          branchName: row.branchName ?? "",
        };
      },
      markBriefDoneFn: async (input) => {
        marks.push(input);
        return { moved: true };
      },
    });
    expect(code).toBe(0);
    expect(merges).toHaveLength(1);
    expect(merges[0]?.row.change).toBe("foo");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.change).toBe("foo");
    // mark-done runs against the caller's cwd, not the worktree, so the
    // move commit lands on the just-merged default branch and the brief
    // that autorun's poll loop reads disappears from `inputs/`.
    expect(marks[0]?.runCwd).toBe(repo);
    expect(out.text()).not.toMatch(/auto-merge-failed/);
  });

  it("conflict path: auto-merge-failed event emitted, no mark-done", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    let nextRunId = 1;
    const factory: AutorunRunFactory = (args) => {
      const runId = `run-${nextRunId++}`;
      const promise = (async () => {
        await seedRunRow(store, runId, args.brief.frontmatter.change, {
          branchName: "run/foo-111111",
          worktreePath: "/wt/foo",
        });
        return { status: "succeeded" as const, runId };
      })();
      return { promise };
    };
    let markCalled = false;
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1, json: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      mergeRunFn: async () => ({
        ok: false,
        reason: "conflict",
        message: "Merge produced conflicts: a.txt",
      }),
      markBriefDoneFn: async () => {
        markCalled = true;
        return { moved: true };
      },
    });
    expect(code).toBe(0);
    expect(markCalled).toBe(false);
    const lines = out.lines().map((l) => JSON.parse(l));
    const failed = lines.find((l) => l.event === "auto-merge-failed");
    expect(failed).toBeDefined();
    expect(failed?.change).toBe("foo");
    expect(failed?.reason).toBe("conflict");
    expect(failed?.detail).toMatch(/a\.txt/);
  });

  it("--ff-only forwarded to mergeRun; non-fast-forward surfaces", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    let nextRunId = 1;
    const factory: AutorunRunFactory = (args) => {
      const runId = `run-${nextRunId++}`;
      const promise = (async () => {
        await seedRunRow(store, runId, args.brief.frontmatter.change, {
          branchName: "run/foo-111111",
          worktreePath: "/wt/foo",
        });
        return { status: "succeeded" as const, runId };
      })();
      return { promise };
    };
    let observedFfOnly: boolean | undefined;
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1, ffOnly: true, json: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      mergeRunFn: async (_row, opts) => {
        observedFfOnly = opts.ffOnly;
        return {
          ok: false,
          reason: "non-fast-forward",
          message: "Fast-forward failed",
        };
      },
    });
    expect(code).toBe(0);
    expect(observedFfOnly).toBe(true);
    const lines = out.lines().map((l) => JSON.parse(l));
    const failed = lines.find((l) => l.event === "auto-merge-failed");
    expect(failed?.reason).toBe("non-fast-forward");
  });

  it("--no-auto-merge: no mergeRun, no autorun-owned mark-done, no failure event", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    let nextRunId = 1;
    const factory: AutorunRunFactory = (args) => {
      const runId = `run-${nextRunId++}`;
      const promise = (async () => {
        await seedRunRow(store, runId, args.brief.frontmatter.change, {
          branchName: "run/foo-111111",
          worktreePath: "/wt/foo",
        });
        return { status: "succeeded" as const, runId };
      })();
      return { promise };
    };
    let mergeCalled = false;
    let markCalled = false;
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1, noAutoMerge: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      mergeRunFn: async () => {
        mergeCalled = true;
        return { ok: true, headSha: "x", defaultBranch: "main", branchName: "b" };
      },
      markBriefDoneFn: async () => {
        markCalled = true;
        return { moved: true };
      },
    });
    expect(code).toBe(0);
    expect(mergeCalled).toBe(false);
    expect(markCalled).toBe(false);
    expect(out.text()).not.toMatch(/auto-merge-failed/);
  });

  it("factory-failed path: auto-merge step NOT invoked; no failure event", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    let nextRunId = 1;
    const factory: AutorunRunFactory = (args) => {
      const runId = `run-${nextRunId++}`;
      const promise = (async () => {
        await seedRunRow(store, runId, args.brief.frontmatter.change, {
          branchName: "run/foo-111111",
          worktreePath: "/wt/foo",
          status: "failed",
          reason: "node_failed",
        });
        return { status: "failed" as const, runId, reason: "node_failed" };
      })();
      return { promise };
    };
    let mergeCalled = false;
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1 },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      mergeRunFn: async () => {
        mergeCalled = true;
        return { ok: true, headSha: "x", defaultBranch: "main", branchName: "b" };
      },
    });
    expect(code).toBe(0);
    expect(mergeCalled).toBe(false);
    expect(out.text()).not.toMatch(/auto-merge-failed/);
  });

  it("null branchName + non-cwd worktree: emits auto-merge-failed reason=null-branch-name", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    let nextRunId = 1;
    const factory: AutorunRunFactory = (args) => {
      const runId = `run-${nextRunId++}`;
      const promise = (async () => {
        // Legacy/pre-migration row: branchName=null AND worktreePath !== cwd.
        await seedRunRow(store, runId, args.brief.frontmatter.change, {
          branchName: null,
          worktreePath: "/some/other/place",
        });
        return { status: "succeeded" as const, runId };
      })();
      return { promise };
    };
    let mergeCalled = false;
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1, json: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      mergeRunFn: async () => {
        mergeCalled = true;
        return { ok: true, headSha: "x", defaultBranch: "main", branchName: "b" };
      },
    });
    expect(code).toBe(0);
    expect(mergeCalled).toBe(false);
    const lines = out.lines().map((l) => JSON.parse(l));
    const failed = lines.find((l) => l.event === "auto-merge-failed");
    expect(failed?.reason).toBe("null-branch-name");
  });

  it("concurrency: two completions serialize through the merge mutex", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "bar");
    const store = await freshStore();
    let nextRunId = 1;
    const factory: AutorunRunFactory = (args) => {
      const runId = `run-${nextRunId++}`;
      const promise = (async () => {
        await seedRunRow(store, runId, args.brief.frontmatter.change, {
          branchName: `run/${args.brief.frontmatter.change}-111111`,
          worktreePath: `/wt/${args.brief.frontmatter.change}`,
        });
        return { status: "succeeded" as const, runId };
      })();
      return { promise };
    };
    let active = 0;
    let observedConcurrent = 0;
    const mergeCalls: string[] = [];
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 2 },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      mergeRunFn: async (row) => {
        active += 1;
        observedConcurrent = Math.max(observedConcurrent, active);
        // Yield twice to give the second completion a chance to race.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        mergeCalls.push(row.change ?? "");
        active -= 1;
        const branchName = row.branchName ?? "";
        return {
          ok: true,
          headSha: "x",
          defaultBranch: "main",
          branchName,
        } satisfies MergeOutcome;
      },
      markBriefDoneFn: async () => ({ moved: true }),
    });
    expect(code).toBe(0);
    expect(mergeCalls.sort()).toEqual(["bar", "foo"]);
    expect(observedConcurrent).toBe(1);
  });

  it("--no-auto-merge with --ff-only is accepted (CLI emits warning; action proceeds)", async () => {
    // The startup-time warning is emitted by the CLI layer (src/cli.ts),
    // not the action. The action here just confirms that supplying both
    // is not a usage error and the action proceeds normally.
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    let nextRunId = 1;
    const factory: AutorunRunFactory = (args) => {
      const runId = `run-${nextRunId++}`;
      const promise = (async () => {
        await seedRunRow(store, runId, args.brief.frontmatter.change, {
          branchName: "run/foo-111111",
          worktreePath: "/wt/foo",
        });
        return { status: "succeeded" as const, runId };
      })();
      return { promise };
    };
    let mergeCalled = false;
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { once: true, maxConcurrent: 1, noAutoMerge: true, ffOnly: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      mergeRunFn: async () => {
        mergeCalled = true;
        return { ok: true, headSha: "x", defaultBranch: "main", branchName: "b" };
      },
    });
    expect(code).toBe(0);
    expect(mergeCalled).toBe(false);
    expect(out.text()).not.toMatch(/auto-merge-failed/);
  });
});
