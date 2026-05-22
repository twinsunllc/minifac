import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SqliteRunStore } from "../storage/sqlite.js";
import type { AutorunRunFactory, RunFactoryResult } from "./autorun-scheduler.js";
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

  it("rejects --max-failures -1 as a usage error", async () => {
    const repo = await makeRepo();
    const store = await freshStore();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { maxFailures: -1, once: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
      openRunStore: async () => store,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--max-failures/);
    await store.close();
  });

  it("rejects --max-failures 1.5 (fractional) as a usage error", async () => {
    const repo = await makeRepo();
    const store = await freshStore();
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await autorunAction({
      options: { maxFailures: 1.5, once: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
      openRunStore: async () => store,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/--max-failures/);
    await store.close();
  });

  it("raw-mode failure-cap log line includes the recovery gesture", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    // Factory that always fails.
    const factory: AutorunRunFactory = () => ({
      promise: Promise.resolve({
        status: "failed" as const,
        runId: "run-x",
        reason: "node_failed",
      }),
    });
    const out = new BufferStream();
    const err = new BufferStream();
    let signalHandler: (() => void) | undefined;
    const codePromise = autorunAction({
      options: { interval: 1, maxConcurrent: 1, maxFailures: 1 },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      installSignalHandlers: ({ onSignal }) => {
        signalHandler = onSignal;
        return () => {
          signalHandler = undefined;
        };
      },
    });
    // Poll until the failure-cap line appears (or timeout).
    const deadline = Date.now() + 4000;
    while (!/skipped foo reason=failure-cap/.test(out.text()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    signalHandler?.();
    await codePromise;
    const text = out.text();
    expect(text).toMatch(/skipped foo reason=failure-cap detail=1\/1/);
    expect(text).toMatch(/restart autorun to retry/);
  });

  it("JSON-mode failure-cap event carries reason and detail", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    const factory: AutorunRunFactory = () => ({
      promise: Promise.resolve({
        status: "failed" as const,
        runId: "run-x",
        reason: "node_failed",
      }),
    });
    const out = new BufferStream();
    const err = new BufferStream();
    let signalHandler: (() => void) | undefined;
    const codePromise = autorunAction({
      options: { interval: 1, maxConcurrent: 1, maxFailures: 1, json: true },
      cwd: repo,
      io: { stdout: out, stderr: err },
      runFactory: factory,
      openRunStore: async () => store,
      installSignalHandlers: ({ onSignal }) => {
        signalHandler = onSignal;
        return () => {
          signalHandler = undefined;
        };
      },
    });
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (
        out
          .lines()
          .some((l) => l.includes('"event":"skipped"') && l.includes('"reason":"failure-cap"'))
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    signalHandler?.();
    await codePromise;
    const cap = out
      .lines()
      .map((l) => JSON.parse(l))
      .find((o) => o.event === "skipped" && o.reason === "failure-cap");
    expect(cap).toBeDefined();
    expect(cap.change).toBe("foo");
    expect(cap.detail).toBe("1/1");
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
