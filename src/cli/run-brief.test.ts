import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBrief } from "../brief/loader.js";
import { ExecutorRegistry } from "../executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode, RunContext } from "../executor/types.js";
import type {
  FinalizeRunInput,
  RecordNodeEndInput,
  RunId,
  RunStore,
} from "../storage/run-store.js";
import { SqliteRunStore } from "../storage/sqlite.js";
import type { LockHandle } from "../worktree/lock.js";
import { claimLock } from "../worktree/lock.js";
import { runBriefAutomated } from "./run-brief.js";

function shOrThrow(cwd: string, args: string[]): void {
  const res = spawnSync(args[0] as string, args.slice(1), { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${res.stderr}`);
  }
}

class FakeExecutor implements NodeExecutor {
  readonly type = "fake";
  async *run(_node: ResolvedNode, _ctx: RunContext): AsyncIterable<NodeEvent> {
    yield { kind: "status", status: "succeeded" };
  }
}

class FailingExecutor implements NodeExecutor {
  readonly type = "fail";
  async *run(_node: ResolvedNode, _ctx: RunContext): AsyncIterable<NodeEvent> {
    yield { kind: "status", status: "failed" };
  }
}

async function setupRepo(executorType: "fake" | "fail"): Promise<{
  repo: string;
  storePath: string;
}> {
  const repo = await mkdtemp(path.join(tmpdir(), "minifac-rba-"));
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
    path.join(repo, "examples", `${executorType}.yaml`),
    `name: ${executorType}-factory
brief: required
nodes:
  only:
    executor: ${executorType}
    terminal: true
    with:
      prompt: "noop"
edges: []
`,
    "utf8",
  );

  await mkdir(path.join(repo, "inputs"), { recursive: true });
  await writeFile(
    path.join(repo, "inputs", "foo.md"),
    `---\nchange: foo\nfactory: ${executorType}\nmode: in-place\n---\nbody\n`,
    "utf8",
  );

  const storeDir = await mkdtemp(path.join(tmpdir(), "minifac-rba-store-"));
  return { repo, storePath: path.join(storeDir, "runs.db") };
}

/**
 * Wrap a RunStore so that `finalizeRun` records the wall-clock time of
 * its resolution. The wrapper also lets a test inject a synthetic delay
 * to widen the window during which the lockfile must still exist.
 */
function wrapStoreRecordingFinalize(
  inner: RunStore,
  opts: { delayMs?: number } = {},
): { store: RunStore; finalizeAt: () => number | null } {
  let finalizeAt: number | null = null;
  const store: RunStore = {
    createRun: (i) => inner.createRun(i),
    appendEvent: (id, e) => inner.appendEvent(id, e),
    recordNodeStart: (id, n, i, at) => inner.recordNodeStart(id, n, i, at),
    recordNodeEnd: (id: RunId, n: string, i: number, end: RecordNodeEndInput) =>
      inner.recordNodeEnd(id, n, i, end),
    async finalizeRun(id, input: FinalizeRunInput) {
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise<void>((res) => setTimeout(res, opts.delayMs));
      }
      await inner.finalizeRun(id, input);
      finalizeAt = Date.now();
    },
    getRun: (id) => inner.getRun(id),
    listRuns: (f) => inner.listRuns(f),
    getRunEvents: (id, o) => inner.getRunEvents(id, o),
    close: () => inner.close(),
  };
  return { store, finalizeAt: () => finalizeAt };
}

/**
 * Wrap `claimLock` so the test sees the wall-clock time of the lockfile
 * `unlink` call (via the handle's `release()`).
 */
function wrapClaimLockRecordingUnlink(): {
  claimLockFn: (lockPath: string) => Promise<LockHandle>;
  unlinkAt: () => number | null;
} {
  let unlinkAt: number | null = null;
  return {
    async claimLockFn(lockPath: string): Promise<LockHandle> {
      const real = await claimLock(lockPath);
      return {
        async release() {
          unlinkAt = Date.now();
          await real.release();
        },
      };
    },
    unlinkAt: () => unlinkAt,
  };
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

describe("runBriefAutomated finalize-before-unlock ordering", () => {
  it("graceful success: finalizeRun resolves before the lockfile unlink", async () => {
    const { repo, storePath } = await setupRepo("fake");
    const inner = SqliteRunStore.open(storePath);
    const { store, finalizeAt } = wrapStoreRecordingFinalize(inner, { delayMs: 30 });
    const { claimLockFn, unlinkAt } = wrapClaimLockRecordingUnlink();
    try {
      const brief = await loadBrief("foo", repo);
      const result = await runBriefAutomated({
        brief,
        cwd: repo,
        store,
        buildRegistry: () => {
          const r = new ExecutorRegistry();
          r.register(new FakeExecutor());
          return r;
        },
        claimLockFn,
      });
      expect(result.status).toBe("succeeded");
      const fa = finalizeAt();
      const ua = unlinkAt();
      expect(fa).not.toBeNull();
      expect(ua).not.toBeNull();
      // Ordering invariant: finalize must complete BEFORE unlink. The
      // synthetic 30ms delay inside the wrapped `finalizeRun` widens the
      // window so a regression that flipped the order would be observable.
      expect(fa as number).toBeLessThanOrEqual(ua as number);
    } finally {
      await inner.close();
    }
  });

  it("graceful failure: finalizeRun resolves before the lockfile unlink", async () => {
    const { repo, storePath } = await setupRepo("fail");
    const inner = SqliteRunStore.open(storePath);
    const { store, finalizeAt } = wrapStoreRecordingFinalize(inner, { delayMs: 30 });
    const { claimLockFn, unlinkAt } = wrapClaimLockRecordingUnlink();
    try {
      const brief = await loadBrief("foo", repo);
      const result = await runBriefAutomated({
        brief,
        cwd: repo,
        store,
        buildRegistry: () => {
          const r = new ExecutorRegistry();
          r.register(new FailingExecutor());
          return r;
        },
        claimLockFn,
      });
      expect(result.status).toBe("failed");
      const fa = finalizeAt();
      const ua = unlinkAt();
      expect(fa).not.toBeNull();
      expect(ua).not.toBeNull();
      expect(fa as number).toBeLessThanOrEqual(ua as number);
    } finally {
      await inner.close();
    }
  });

  it("finalize error is non-fatal: lockfile is still unlinked", async () => {
    const { repo, storePath } = await setupRepo("fake");
    const inner = SqliteRunStore.open(storePath);
    // Wrap so finalizeRun rejects. The runner's finalize call is wrapped in
    // try/catch and reported via onEvent, so the run still returns and the
    // outer finally still runs lock.release(). The lock therefore must
    // not leak.
    const rejectingStore: RunStore = {
      createRun: (i) => inner.createRun(i),
      appendEvent: (id, e) => inner.appendEvent(id, e),
      recordNodeStart: (id, n, i, at) => inner.recordNodeStart(id, n, i, at),
      recordNodeEnd: (id, n, i, end) => inner.recordNodeEnd(id, n, i, end),
      async finalizeRun(_id, _input) {
        throw new Error("synthetic finalize failure");
      },
      getRun: (id) => inner.getRun(id),
      listRuns: (f) => inner.listRuns(f),
      getRunEvents: (id, o) => inner.getRunEvents(id, o),
      close: () => inner.close(),
    };
    const { claimLockFn, unlinkAt } = wrapClaimLockRecordingUnlink();
    try {
      const brief = await loadBrief("foo", repo);
      const result = await runBriefAutomated({
        brief,
        cwd: repo,
        store: rejectingStore,
        buildRegistry: () => {
          const r = new ExecutorRegistry();
          r.register(new FakeExecutor());
          return r;
        },
        claimLockFn,
      });
      // Run-level result reflects the graph outcome; finalize error is
      // surfaced via the synthetic stderr event, not the result status.
      expect(result.status).toBe("succeeded");
      // Lockfile was still unlinked (no leak).
      expect(unlinkAt()).not.toBeNull();
    } finally {
      await inner.close();
    }
  });
});
