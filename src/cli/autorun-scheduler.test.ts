import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBrief } from "../brief/loader.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import { parseAutorunFilter } from "./autorun-filter.js";
import {
  type AutorunRunFactory,
  type ProbeChangeLiveness,
  type RunFactoryResult,
  Scheduler,
} from "./autorun-scheduler.js";

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
        maxFailures: 0,
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
        maxFailures: 0,
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
        maxFailures: 0,
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
        maxFailures: 0,
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
        maxFailures: 0,
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

  it("returns skip:running-elsewhere when the probe reports a live PID for a running row", async () => {
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
      const probe: ProbeChangeLiveness = async () => ({ running: true, pid: 4242 });
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        probeChangeLiveness: probe,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("running-elsewhere");
      // Row was NOT reconciled.
      const rows = await store.listRuns({ change: "foo", limit: 1 });
      expect(rows[0]?.status).toBe("running");
    } finally {
      await store.close();
    }
  });

  it("orphan reconciles the row to failed/orphaned and schedules the brief on the same poll", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const startedAt = 1_000_000;
      await store.createRun({
        id: "run-1",
        factoryPath: "x.yaml",
        factoryName: "sdd",
        change: "foo",
        startedAt,
      });
      const brief = await loadBrief("foo", repo);
      const probe: ProbeChangeLiveness = async () => ({ orphaned: true });
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        probeChangeLiveness: probe,
        now: () => 2_000_000,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("schedule");
      const rows = await store.listRuns({ change: "foo", limit: 1 });
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.reason).toBe("orphaned");
      expect(rows[0]?.endedAt).toBe(2_000_000);
    } finally {
      await store.close();
    }
  });

  it("orphan reconciles even when the brief has an unsatisfied dep (skip:blocked)", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo", ["bar"]);
    await writeBrief(repo, "active", "bar"); // dep is active, not done
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
      const probe: ProbeChangeLiveness = async () => ({ orphaned: true });
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        probeChangeLiveness: probe,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("blocked");
      // The row WAS still reconciled.
      const rows = await store.listRuns({ change: "foo", limit: 1 });
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.reason).toBe("orphaned");
    } finally {
      await store.close();
    }
  });

  it("probe error skips with running-elsewhere and leaves the row untouched", async () => {
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
      const probe: ProbeChangeLiveness = async () => {
        throw new Error("synthetic probe I/O error");
      };
      const sched = new Scheduler({
        runFactory: () => ({
          promise: Promise.resolve({ status: "succeeded" as const }),
        }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        probeChangeLiveness: probe,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("running-elsewhere");
      const rows = await store.listRuns({ change: "foo", limit: 1 });
      expect(rows[0]?.status).toBe("running");
    } finally {
      await store.close();
    }
  });

  it("without an injected probe, a running row skips with running-elsewhere", async () => {
    // Conservative default: no probe ⇒ we treat every running row as a
    // legitimately busy run elsewhere.
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
        maxFailures: 0,
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("running-elsewhere");
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
        maxFailures: 0,
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
        maxFailures: 0,
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
        maxFailures: 0,
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
        maxFailures: 0,
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
        maxFailures: 0,
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
        maxFailures: 0,
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

describe("Scheduler failure-cap", () => {
  // Helper: bring `change` to a state where its run row is `failed`
  // and its in-flight slot is released, by start()ing it and resolving
  // the controllable factory with a failure result.
  async function failOnce(
    sched: Scheduler,
    ctrl: ControllableRun,
    brief: Awaited<ReturnType<typeof loadBrief>>,
    reason?: string,
  ): Promise<void> {
    sched.start(brief);
    ctrl.resolveLatest(reason !== undefined ? { status: "failed", reason } : { status: "failed" });
    await sched.drain();
  }

  it("counter increments on a failed dispatch with a recognized node-side reason", async () => {
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
        maxFailures: 3,
      });
      for (const reason of [
        "node_failed",
        "graph_drained",
        "budget_exhausted",
        "sentinel_failed",
      ]) {
        const fresh = new Scheduler({
          runFactory: ctrl.factory,
          runStore: store,
          inputsDir: path.join(repo, "inputs"),
          repoRoot: repo,
          maxConcurrent: 1,
          maxFailures: 3,
        });
        await failOnce(fresh, ctrl, brief, reason);
        expect(fresh.failureCount("foo")).toBe(1);
      }
      // Sanity: the original scheduler is still at zero.
      expect(sched.failureCount("foo")).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("counter does NOT increment when result.reason === 'user_quit'", async () => {
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
        maxFailures: 3,
      });
      await failOnce(sched, ctrl, brief, "user_quit");
      expect(sched.failureCount("foo")).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("counter increments when result.reason is undefined", async () => {
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
        maxFailures: 3,
      });
      await failOnce(sched, ctrl, brief);
      expect(sched.failureCount("foo")).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("skips with reason=failure-cap and detail=N/N after maxFailures consecutive failures", async () => {
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
        maxFailures: 3,
      });
      for (let i = 0; i < 3; i++) {
        await failOnce(sched, ctrl, brief, "node_failed");
      }
      expect(sched.failureCount("foo")).toBe(3);
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") {
        expect(d.reason).toBe("failure-cap");
        expect(d.detail).toBe("3/3");
      }
    } finally {
      await store.close();
    }
  });

  it("maxFailures: 0 disables the cap (no skip even after many failures)", async () => {
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
        maxFailures: 0,
      });
      for (let i = 0; i < 10; i++) {
        await failOnce(sched, ctrl, brief, "node_failed");
      }
      expect(sched.failureCount("foo")).toBe(10);
      const d = await sched.decide(brief);
      expect(d.action).toBe("schedule");
    } finally {
      await store.close();
    }
  });

  it("maxFailures: 5 allows 5 failures, then caps on the 6th decide call", async () => {
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
        maxFailures: 5,
      });
      for (let i = 0; i < 5; i++) {
        const d = await sched.decide(brief);
        expect(d.action).toBe("schedule");
        await failOnce(sched, ctrl, brief, "node_failed");
      }
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") {
        expect(d.reason).toBe("failure-cap");
        expect(d.detail).toBe("5/5");
      }
    } finally {
      await store.close();
    }
  });

  it("per-change isolation: a cap on change A does not affect change B", async () => {
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
        maxFailures: 2,
      });
      await failOnce(sched, ctrl, briefFoo, "node_failed");
      await failOnce(sched, ctrl, briefFoo, "node_failed");
      const dFoo = await sched.decide(briefFoo);
      expect(dFoo.action).toBe("skip");
      if (dFoo.action === "skip") expect(dFoo.reason).toBe("failure-cap");
      const dBar = await sched.decide(briefBar);
      expect(dBar.action).toBe("schedule");
    } finally {
      await store.close();
    }
  });

  it("precedence: a capped brief with unsatisfied deps surfaces as 'blocked', not 'failure-cap'", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo", ["bar"]);
    await writeBrief(repo, "active", "bar"); // dep active, not done
    const store = await freshStore();
    try {
      const briefFoo = await loadBrief("foo", repo);
      const ctrl = makeControllableRunFactory();
      const sched = new Scheduler({
        runFactory: ctrl.factory,
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 1,
      });
      // Manually warm the counter (no need to actually dispatch — the
      // precondition order is what we're testing).
      // Simulate one failure by start + fail.
      // foo can't actually schedule here (blocked); use a back door:
      // run the same brief in a maxFailures=0 scheduler is too noisy.
      // Easier: bypass decide() and call start() directly.
      sched.start(briefFoo);
      ctrl.resolveLatest({ status: "failed", reason: "node_failed" });
      await sched.drain();
      expect(sched.failureCount("foo")).toBe(1);
      const d = await sched.decide(briefFoo);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("blocked");
    } finally {
      await store.close();
    }
  });

  it("precedence: a capped brief already in-flight surfaces as 'in-flight', not 'failure-cap'", async () => {
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
        maxFailures: 1,
      });
      // First failure to bring foo to the cap.
      await failOnce(sched, ctrl, brief, "node_failed");
      expect(sched.failureCount("foo")).toBe(1);
      // Force a second dispatch (bypass decide()) so foo is in-flight
      // and capped simultaneously.
      sched.start(brief);
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("in-flight");
      ctrl.resolveLatest({ status: "succeeded" });
      await sched.drain();
    } finally {
      await store.close();
    }
  });

  it("fresh Scheduler instance starts with an empty counter (restart-to-reset)", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const ctrl = makeControllableRunFactory();
      const sched1 = new Scheduler({
        runFactory: ctrl.factory,
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 2,
      });
      await failOnce(sched1, ctrl, brief, "node_failed");
      await failOnce(sched1, ctrl, brief, "node_failed");
      expect(sched1.failureCount("foo")).toBe(2);
      // A fresh Scheduler has no shared state.
      const sched2 = new Scheduler({
        runFactory: ctrl.factory,
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 2,
      });
      expect(sched2.failureCount("foo")).toBe(0);
    } finally {
      await store.close();
    }
  });
});

describe("Scheduler cleanliness gate", () => {
  function fakeRunner(
    map: Record<string, { stdout?: string; stderr?: string; exitCode?: number | null }>,
  ): import("../brief/cleanliness.js").GitStatusRunner {
    return async (_repoRoot, briefPath) => {
      const r = map[path.basename(briefPath)] ?? { stdout: "", exitCode: 0 };
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.exitCode ?? 0,
      };
    };
  }

  it("untracked brief skips with reason=unclean detail=??", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const sched = new Scheduler({
        runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 0,
        cleanlinessRunner: fakeRunner({ "foo.md": { stdout: "?? inputs/foo.md\n" } }),
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") {
        expect(d.reason).toBe("unclean");
        expect(d.detail).toBe("??");
      }
    } finally {
      await store.close();
    }
  });

  it("modified brief skips with reason=unclean detail=' M'", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const sched = new Scheduler({
        runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 0,
        cleanlinessRunner: fakeRunner({ "foo.md": { stdout: " M inputs/foo.md\n" } }),
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") {
        expect(d.reason).toBe("unclean");
        expect(d.detail).toBe(" M");
      }
    } finally {
      await store.close();
    }
  });

  it("unclean ancestor surfaces detail=<offending> (<code>)", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "bar");
    await writeBrief(repo, "active", "foo", ["bar"]);
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const sched = new Scheduler({
        runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 0,
        cleanlinessRunner: fakeRunner({
          "foo.md": { stdout: "" },
          "bar.md": { stdout: "?? inputs/bar.md\n" },
        }),
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("skip");
      if (d.action === "skip") {
        expect(d.reason).toBe("unclean");
        expect(d.detail).toBe("bar (??)");
      }
    } finally {
      await store.close();
    }
  });

  it("clean brief falls through to state-based dispatch", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    const store = await freshStore();
    try {
      const brief = await loadBrief("foo", repo);
      const sched = new Scheduler({
        runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 0,
        cleanlinessRunner: fakeRunner({ "foo.md": { stdout: "" } }),
      });
      const d = await sched.decide(brief);
      expect(d.action).toBe("schedule");
    } finally {
      await store.close();
    }
  });

  it("disabled gate falls through and emits one-time warning", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "foo");
    await writeBrief(repo, "active", "bar");
    const store = await freshStore();
    try {
      const briefFoo = await loadBrief("foo", repo);
      const briefBar = await loadBrief("bar", repo);
      let warned = 0;
      const sched = new Scheduler({
        runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 2,
        maxFailures: 0,
        cleanlinessRunner: async () => ({
          stdout: "",
          stderr: "fatal: not a git repository\n",
          exitCode: 128,
        }),
        onCleanlinessDisabled: () => {
          warned += 1;
        },
      });
      const d1 = await sched.decide(briefFoo);
      expect(d1.action).toBe("schedule");
      const d2 = await sched.decide(briefBar);
      expect(d2.action).toBe("schedule");
      expect(warned).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("in-flight precedence: unclean brief already in-flight surfaces as in-flight", async () => {
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
        maxFailures: 0,
        cleanlinessRunner: fakeRunner({ "foo.md": { stdout: "?? inputs/foo.md\n" } }),
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

  it("filtered precedence: unclean brief that does not match filter surfaces as filtered", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "chore-baz");
    const store = await freshStore();
    try {
      const brief = await loadBrief("chore-baz", repo);
      const sched = new Scheduler({
        runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 0,
        cleanlinessRunner: fakeRunner({ "chore-baz.md": { stdout: "?? inputs/chore-baz.md\n" } }),
      });
      const d = await sched.decide(brief, parseAutorunFilter("feat-*"));
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toBe("filtered");
    } finally {
      await store.close();
    }
  });

  it("cycle in depends_on surfaces as blocked, not unclean", async () => {
    const repo = await makeRepo();
    await writeBrief(repo, "active", "a", ["b"]);
    await writeBrief(repo, "active", "b", ["a"]);
    const store = await freshStore();
    try {
      const brief = await loadBrief("a", repo);
      const sched = new Scheduler({
        runFactory: () => ({ promise: Promise.resolve({ status: "succeeded" as const }) }),
        runStore: store,
        inputsDir: path.join(repo, "inputs"),
        repoRoot: repo,
        maxConcurrent: 1,
        maxFailures: 0,
        // Both briefs are reported clean so the cycle has to come from the
        // recursive walk, not from cleanliness.
        cleanlinessRunner: fakeRunner({ "a.md": { stdout: "" }, "b.md": { stdout: "" } }),
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
