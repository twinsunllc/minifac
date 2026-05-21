import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  AppendEventInput,
  CreateRunInput,
  FinalizeRunInput,
  GetEventsOptions,
  ListRunsFilter,
  RecordNodeEndInput,
  RunStore,
  StoredEvent,
  StoredRun,
} from "../storage/run-store.js";
import type { GitRunResult, SpawnGit } from "./merge.js";
import { runMerge } from "./merge.js";

class BufferStream extends Writable {
  chunks: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: Writable callback uses any internally
  _write(chunk: any, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

function stdinFrom(s: string): NodeJS.ReadableStream {
  return Readable.from([s]);
}
function emptyStdin(): NodeJS.ReadableStream {
  // A readable that ends immediately. The prompt then sees EOF.
  return Readable.from([]);
}

class MemStore implements RunStore {
  rows: StoredRun[] = [];
  seed(r: Partial<StoredRun> & { id: string }): StoredRun {
    const row: StoredRun = {
      id: r.id,
      factoryPath: r.factoryPath ?? "/p/f.yaml",
      factoryName: r.factoryName ?? "f",
      briefPath: r.briefPath ?? null,
      change: r.change ?? null,
      baseBranch: r.baseBranch ?? null,
      worktreePath: r.worktreePath ?? null,
      branchName: r.branchName ?? null,
      status: r.status ?? "succeeded",
      reason: r.reason ?? null,
      proximateNodeId: r.proximateNodeId ?? null,
      startedAt: r.startedAt ?? 0,
      endedAt: r.endedAt ?? 1,
    };
    this.rows.push(row);
    return row;
  }
  async createRun(_input: CreateRunInput): Promise<void> {}
  async appendEvent(_runId: string, _event: AppendEventInput): Promise<StoredEvent> {
    return { seq: 0, nodeId: null, iteration: 0, kind: "stdout", payload: null, emittedAt: 0 };
  }
  async recordNodeStart(): Promise<void> {}
  async recordNodeEnd(
    _runId: string,
    _nodeId: string,
    _iteration: number,
    _end: RecordNodeEndInput,
  ): Promise<void> {}
  async finalizeRun(_runId: string, _input: FinalizeRunInput): Promise<void> {}
  async getRun(runId: string): Promise<StoredRun | null> {
    return this.rows.find((r) => r.id === runId) ?? null;
  }
  async listRuns(filter?: ListRunsFilter): Promise<StoredRun[]> {
    let rows = this.rows.slice();
    if (filter?.change !== undefined) rows = rows.filter((r) => r.change === filter.change);
    if (filter?.status !== undefined) rows = rows.filter((r) => r.status === filter.status);
    if (filter?.factoryName !== undefined)
      rows = rows.filter((r) => r.factoryName === filter.factoryName);
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  }
  async getRunEvents(_runId: string, _opts?: GetEventsOptions): Promise<StoredEvent[]> {
    return [];
  }
  async close(): Promise<void> {}
}

interface ScriptedGitCall {
  match: (args: readonly string[]) => boolean;
  result: GitRunResult;
}

function makeSpawn(calls: ScriptedGitCall[]): { spawn: SpawnGit; invocations: string[][] } {
  const invocations: string[][] = [];
  const spawnGit: SpawnGit = async (_cwd, args) => {
    invocations.push([...args]);
    for (const c of calls) {
      if (c.match(args)) return c.result;
    }
    return { stdout: "", stderr: `no scripted result for: git ${args.join(" ")}`, exitCode: 1 };
  };
  return { spawn: spawnGit, invocations };
}

const argsEq =
  (...want: string[]) =>
  (got: readonly string[]) =>
    got.length === want.length && want.every((w, i) => got[i] === w);
const startsWith =
  (...want: string[]) =>
  (got: readonly string[]) =>
    want.every((w, i) => got[i] === w);

describe("runMerge", () => {
  it("resolve-by-change with one succeeded run fast-forwards", async () => {
    const store = new MemStore();
    store.seed({
      id: "11111111-aaaa",
      change: "feat-x",
      branchName: "run/feat-x-111111",
      status: "succeeded",
      startedAt: 1,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const { spawn } = makeSpawn([
      { match: argsEq("status", "--porcelain"), result: { stdout: "", stderr: "", exitCode: 0 } },
      {
        match: argsEq("rev-parse", "--abbrev-ref", "HEAD"),
        result: { stdout: "main\n", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("merge", "--ff-only", "run/feat-x-111111"),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("rev-parse", "HEAD"),
        result: { stdout: "deadbeef\n", stderr: "", exitCode: 0 },
      },
    ]);
    const code = await runMerge({
      arg: "feat-x",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/Merged `run\/feat-x-111111` into `main` at deadbeef/);
  });

  it("resolve-by-change with multiple succeeded runs is refused without --pick", async () => {
    const store = new MemStore();
    store.seed({
      id: "11111111-a",
      change: "feat-x",
      branchName: "run/feat-x-111111",
      status: "succeeded",
      startedAt: 1,
    });
    store.seed({
      id: "22222222-a",
      change: "feat-x",
      branchName: "run/feat-x-222222",
      status: "succeeded",
      startedAt: 2,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const { spawn } = makeSpawn([]);
    const code = await runMerge({
      arg: "feat-x",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/Multiple succeeded runs/);
    expect(err.text()).toMatch(/--pick/);
  });

  it("resolve-by-change with --pick + `2` selects the second", async () => {
    const store = new MemStore();
    store.seed({
      id: "11111111-a",
      change: "feat-x",
      branchName: "run/feat-x-111111",
      status: "succeeded",
      startedAt: 1,
    });
    store.seed({
      id: "22222222-a",
      change: "feat-x",
      branchName: "run/feat-x-222222",
      status: "succeeded",
      startedAt: 2,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    // The listing is sorted by startedAt-desc, so `2` should pick the older one (id 11111111).
    const { spawn } = makeSpawn([
      { match: argsEq("status", "--porcelain"), result: { stdout: "", stderr: "", exitCode: 0 } },
      {
        match: argsEq("rev-parse", "--abbrev-ref", "HEAD"),
        result: { stdout: "main\n", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("merge", "--ff-only", "run/feat-x-111111"),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("rev-parse", "HEAD"),
        result: { stdout: "cafebabe\n", stderr: "", exitCode: 0 },
      },
    ]);
    const code = await runMerge({
      arg: "feat-x",
      pick: true,
      store,
      cwd: "/repo",
      stdin: stdinFrom("2\n"),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/Merged `run\/feat-x-111111` into `main` at cafebabe/);
  });

  it("resolve-by-run-id prefix succeeds", async () => {
    const store = new MemStore();
    store.seed({
      id: "abcdef0123-456",
      change: "feat-y",
      branchName: "run/feat-y-abcdef",
      status: "succeeded",
      startedAt: 1,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const { spawn } = makeSpawn([
      { match: argsEq("status", "--porcelain"), result: { stdout: "", stderr: "", exitCode: 0 } },
      {
        match: argsEq("rev-parse", "--abbrev-ref", "HEAD"),
        result: { stdout: "main\n", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("merge", "--ff-only", "run/feat-y-abcdef"),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("rev-parse", "HEAD"),
        result: { stdout: "abc1234\n", stderr: "", exitCode: 0 },
      },
    ]);
    const code = await runMerge({
      arg: "abcdef",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code).toBe(0);
  });

  it("ambiguous run-id prefix is a usage error", async () => {
    const store = new MemStore();
    store.seed({
      id: "abcdef111111",
      change: "feat-a",
      branchName: "run/a-aaaaaa",
      status: "succeeded",
      startedAt: 1,
    });
    store.seed({
      id: "abcdef222222",
      change: "feat-b",
      branchName: "run/b-bbbbbb",
      status: "succeeded",
      startedAt: 2,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runMerge({
      arg: "abcdef",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: makeSpawn([]).spawn,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/ambiguous/i);
  });

  it("non-succeeded run is refused without --force; allowed with --force", async () => {
    const store = new MemStore();
    store.seed({
      id: "ffff1111-a",
      change: "feat-z",
      branchName: "run/feat-z-ffffff",
      status: "failed",
      startedAt: 1,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const code1 = await runMerge({
      arg: "feat-z",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: makeSpawn([]).spawn,
    });
    expect(code1).toBe(1);
    expect(err.text()).toMatch(/No succeeded runs|--force/);

    const out2 = new BufferStream();
    const err2 = new BufferStream();
    const { spawn } = makeSpawn([
      { match: argsEq("status", "--porcelain"), result: { stdout: "", stderr: "", exitCode: 0 } },
      {
        match: argsEq("rev-parse", "--abbrev-ref", "HEAD"),
        result: { stdout: "main\n", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("merge", "--ff-only", "run/feat-z-ffffff"),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("rev-parse", "HEAD"),
        result: { stdout: "zzz\n", stderr: "", exitCode: 0 },
      },
    ]);
    const code2 = await runMerge({
      arg: "feat-z",
      force: true,
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out2,
      stderr: err2,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code2).toBe(0);
  });

  it("merge with conflicts aborts cleanly and lists conflicting paths", async () => {
    const store = new MemStore();
    store.seed({
      id: "cccc1111-a",
      change: "feat-c",
      branchName: "run/feat-c-cccccc",
      status: "succeeded",
      startedAt: 1,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const calls: ScriptedGitCall[] = [
      { match: argsEq("status", "--porcelain"), result: { stdout: "", stderr: "", exitCode: 0 } },
      {
        match: argsEq("rev-parse", "--abbrev-ref", "HEAD"),
        result: { stdout: "main\n", stderr: "", exitCode: 0 },
      },
      // ff-only fails
      {
        match: argsEq("merge", "--ff-only", "run/feat-c-cccccc"),
        result: { stdout: "", stderr: "not a fast-forward", exitCode: 1 },
      },
      // merge --no-ff fails with conflicts
      {
        match: startsWith("merge", "--no-ff", "-m"),
        result: { stdout: "", stderr: "CONFLICT", exitCode: 1 },
      },
      {
        match: argsEq("merge", "--abort"),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("diff", "--name-only", "--diff-filter=U"),
        result: { stdout: "a.txt\nb.txt\n", stderr: "", exitCode: 0 },
      },
    ];
    const { spawn, invocations } = makeSpawn(calls);
    const code = await runMerge({
      arg: "feat-c",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/produced conflicts/);
    expect(err.text()).toMatch(/a\.txt/);
    expect(err.text()).toMatch(/b\.txt/);
    // Did NOT delete the branch.
    expect(invocations.some((a) => a[0] === "branch" && a[1] === "-D")).toBe(false);
  });

  it("--ff-only refuses the merge-commit fallback", async () => {
    const store = new MemStore();
    store.seed({
      id: "ffff2222-a",
      change: "feat-q",
      branchName: "run/feat-q-ffffff",
      status: "succeeded",
      startedAt: 1,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const { spawn, invocations } = makeSpawn([
      { match: argsEq("status", "--porcelain"), result: { stdout: "", stderr: "", exitCode: 0 } },
      {
        match: argsEq("rev-parse", "--abbrev-ref", "HEAD"),
        result: { stdout: "main\n", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("merge", "--ff-only", "run/feat-q-ffffff"),
        result: { stdout: "", stderr: "not a fast-forward", exitCode: 1 },
      },
    ]);
    const code = await runMerge({
      arg: "feat-q",
      ffOnly: true,
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/Fast-forward.*failed/);
    expect(invocations.some((a) => a[0] === "merge" && a[1] === "--no-ff")).toBe(false);
  });

  it("dirty working tree refuses with stash hint", async () => {
    const store = new MemStore();
    store.seed({
      id: "dddd1111-a",
      change: "feat-d",
      branchName: "run/feat-d-dddddd",
      status: "succeeded",
      startedAt: 1,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const { spawn } = makeSpawn([
      {
        match: argsEq("status", "--porcelain"),
        result: { stdout: " M src/foo.ts\n", stderr: "", exitCode: 0 },
      },
    ]);
    const code = await runMerge({
      arg: "feat-d",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/stash/i);
  });

  it("branchName == null is refused with the documented message", async () => {
    const store = new MemStore();
    store.seed({
      id: "legacy-1",
      change: "feat-old",
      branchName: null,
      status: "succeeded",
      startedAt: 1,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runMerge({
      arg: "feat-old",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: makeSpawn([]).spawn,
    });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/predates per-run branch naming/i);
  });

  it("merge does NOT delete the branch on success", async () => {
    const store = new MemStore();
    store.seed({
      id: "ssss1111-a",
      change: "feat-s",
      branchName: "run/feat-s-ssssss",
      status: "succeeded",
      startedAt: 1,
    });
    const out = new BufferStream();
    const err = new BufferStream();
    const { spawn, invocations } = makeSpawn([
      { match: argsEq("status", "--porcelain"), result: { stdout: "", stderr: "", exitCode: 0 } },
      {
        match: argsEq("rev-parse", "--abbrev-ref", "HEAD"),
        result: { stdout: "main\n", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("merge", "--ff-only", "run/feat-s-ssssss"),
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: argsEq("rev-parse", "HEAD"),
        result: { stdout: "abc\n", stderr: "", exitCode: 0 },
      },
    ]);
    const code = await runMerge({
      arg: "feat-s",
      store,
      cwd: "/repo",
      stdin: emptyStdin(),
      stdout: out,
      stderr: err,
      resolveDefaultBranch: async () => "main",
      spawnGit: spawn,
    });
    expect(code).toBe(0);
    expect(invocations.some((a) => a[0] === "branch" && a[1] === "-D")).toBe(false);
  });
});
