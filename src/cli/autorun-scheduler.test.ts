import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBrief } from "../brief/loader.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import { parseAutorunFilter } from "./autorun-filter.js";
import { type AutorunRunFactory, type RunFactoryResult, Scheduler } from "./autorun-scheduler.js";

async function makeRepo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "minifac-scheduler-"));
}

async function freshStore(): Promise<SqliteRunStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "minifac-scheduler-db-"));
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

interface ControllableRun {
  factory: AutorunRunFactory;
  /** number of times the factory was invoked */
  calls: { brief: { change: string } }[];
  /** resolve the most recent pending run */
  resolveLatest: (result?: RunFactoryResult) => void;
  /** kill calls captured on the latest child handle */
  killSignals: NodeJS.Signals[];
}

function makeControllableRunFactory(): ControllableRun {
  const calls: ControllableRun["calls"] = [];
  const killSignals: NodeJS.Signals[] = [];
  const pending: Array<{
    resolve: (r: RunFactoryResult) => void;
  }> = [];
  const factory: AutorunRunFactory = (args) => {
    calls.push({ brief: { change: args.brief.frontmatter.change } });
    let resolveFn: (r: RunFactoryResult) => void = () => undefined;
    const promise = new Promise<RunFactoryResult>((res) => {
      resolveFn = res;
    });
    pending.push({ resolve: resolveFn });
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
  };
}

describe("Scheduler.decide", () => {
  it("returns schedule for a ready brief", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("schedule");
    } finally {
      await store.close();
    }
  });

  it("returns skip:blocked when a dep is unsatisfied", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo", ["bar"]);
    await writeBrief(repo, "active", "bar"); // dep is active, not done
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("blocked");
    } finally {
      await store.close();
    }
  });

  it("returns skip:concurrency when in-flight is at capacity", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "bar");
    const store = await freshStore();
    try {
      const briefFoo = await loadBrief("foo", repo);
      const briefBar = await loadBrief("bar", repo);
      const ctrl = makeControllableRunFactory();
      const sched = new Scheduler({
        runFactory: ctrl.factory,
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      sched.start(briefFoo);
      const d = await sched.decide(briefBar);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("concurrency");
      ctrl.resolveLatest();
      await sched.drain();
    } finally {
      await store.close();
    }
  });

  it("returns skip:filtered when the filter rejects", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "chore-baz");
    const store = await freshStore();
    try {
      const brief = await loadBrief("chore-baz", repo);
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      const d = await sched.decide(brief, parseAutorunFilter("feat-*"));
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("filtered");
    } finally {
      await store.close();
    }
  });

  it("returns skip:in-flight when the change is already running locally", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const ctrl = makeControllableRunFactory();
      const sched = new Scheduler({
        runFactory: ctrl.factory,
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 2,
      });
      sched.start(brief);
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("in-flight");
      ctrl.resolveLatest();
      await sched.drain();
    } finally {
      await store.close();
    }
  });

  it("returns skip:activity-running when the most recent run row is running", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      await store.createRun({
        id: "run-1",
        factoryPath: "x.yaml",
        factoryName: "sdd",
        change: "foo",
        startedAt: Date.now(),
      });
      const brief = await loadBrief("foo", repo);
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("activity-running");
    } finally {
      await store.close();
    }
  });

  it("returns skip:activity-succeeded when the most recent run row is succeeded", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const now = Date.now();
      await store.createRun({
        id: "run-1",
        factoryPath: "x.yaml",
        factoryName: "sdd",
        change: "foo",
        startedAt: now,
      });
      await store.finalizeRun("run-1", { status: "succeeded", endedAt: now + 100 });
      const brief = await loadBrief("foo", repo);
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("activity-succeeded");
    } finally {
      await store.close();
    }
  });

  it("returns skip:done when the brief lives in inputs/done/", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "done", "foo");
    const store = await freshStore();
    try {
      const briefPath = path.join(repo, "inputs", "done", "foo.md");
      const brief = await loadBrief(briefPath, repo);
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("done");
    } finally {
      await store.close();
    }
  });

  it("returns skip:blocked with a cycle detail when a cycle is detected", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "a", ["b"]);
    await writeBrief(repo, "active", "b", ["a"]);
    const store = await freshStore();
    try {
      const brief = await loadBrief("a", repo);
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") {
        expect(d.reason).toBe("blocked");
        expect(d.detail).toMatch(/^cycle:/);
      }
    } finally {
      await store.close();
    }
  });
});

describe("Scheduler.start / drain / killAllInFlight", () => {
  it("start increments inFlight and the run primitive is called with the expected brief", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const ctrl = makeControllableRunFactory();
      const sched = new Scheduler({
        runFactory: ctrl.factory,
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      sched.start(brief);
      expect(sched.inFlightCount()).toBe(1);
      expect(ctrl.calls).toHaveLength(1);
      expect(ctrl.calls[0]?.brief.change).toBe("foo");
      ctrl.resolveLatest();
      await sched.drain();
      expect(sched.inFlightCount()).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("drain resolves only after all in-flight promises settle", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "bar");
    const store = await freshStore();
    try {
      const briefFoo = await loadBrief("foo", repo);
      const briefBar = await loadBrief("bar", repo);
      const ctrl = makeControllableRunFactory();
      const sched = new Scheduler({
        runFactory: ctrl.factory,
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 2,
      });
      sched.start(briefFoo);
      sched.start(briefBar);
      let drained = false;
      const drainPromise = sched.drain().then(() => {
        drained = true;
      });
      // Yield to let scheduler register both promises.
      await Promise.resolve();
      expect(drained).toBe(false);
      ctrl.resolveLatest();
      await Promise.resolve();
      expect(drained).toBe(false);
      ctrl.resolveLatest();
      await drainPromise;
      expect(drained).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("killAllInFlight sends SIGTERM to tracked child handles and marks killed", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const ctrl = makeControllableRunFactory();
      const sched = new Scheduler({
        runFactory: ctrl.factory,
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
      });
      sched.start(brief);
      sched.killAllInFlight();
      expect(ctrl.killSignals).toEqual(["SIGTERM"]);
      expect(sched.anyKilled()).toBe(true);
      ctrl.resolveLatest({ status: "failed", reason: "killed" });
      await sched.drain();
    } finally {
      await store.close();
    }
  });
});
