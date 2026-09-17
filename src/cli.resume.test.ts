import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import { ExecutorRegistry } from "./executor/registry.js";
import type { NodeEvent, NodeExecutor, ResolvedNode } from "./executor/types.js";
import { SqliteRunStore } from "./storage/sqlite.js";

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

const FACTORY = `name: scarif
brief: none
nodes:
  plan:
    executor: test
    with:
      prompt: "plan {{ brief.change }}"
  evaluate:
    executor: test
    terminal: true
    with:
      prompt: "evaluate; answer=[{{ run.feedback }}]"
edges:
  - from: plan
    to: evaluate
    when: on_success
`;

const RUN_ID = "abcdef01-2345-6789-abcd-ef0123456789";

/** Prompts the fake executor was handed, per node id. */
const prompts: Array<{ nodeId: string; prompt: string }> = [];

function fakeRegistry(): () => ExecutorRegistry {
  return () => {
    const reg = new ExecutorRegistry();
    const exec: NodeExecutor = {
      type: "test",
      supportsMcp: false,
      supportsNudge: false,
      supportsResume: false,
      async *run(node: ResolvedNode): AsyncIterable<NodeEvent> {
        prompts.push({
          nodeId: node.id,
          prompt: typeof node.with?.prompt === "string" ? node.with.prompt : "",
        });
        yield { kind: "status", status: "succeeded" };
      },
    };
    reg.register(exec);
    return reg;
  };
}

describe("minifac run --resume", () => {
  let savedHome: string | undefined;
  let dir: string;
  let dbPath: string;
  let factoryPath: string;

  const openRunStore = async (): Promise<SqliteRunStore> => SqliteRunStore.open(dbPath);

  beforeEach(async () => {
    savedHome = process.env.MINIFAC_HOME;
    dir = await mkdtemp(path.join(tmpdir(), "minifac-cli-resume-"));
    process.env.MINIFAC_HOME = path.join(dir, "home");
    dbPath = path.join(dir, "runs.db");
    factoryPath = path.join(dir, "examples", "scarif.yaml");
    await mkdir(path.dirname(factoryPath), { recursive: true });
    await writeFile(factoryPath, FACTORY, "utf8");
    prompts.length = 0;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
    if (savedHome === undefined) delete process.env.MINIFAC_HOME;
    else process.env.MINIFAC_HOME = savedHome;
  });

  /** Seed a parked run: plan succeeded, evaluate failed with an escalation. */
  async function seedParkedRun(over?: { worktreePath?: string | null }): Promise<void> {
    const store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: RUN_ID,
      factoryPath,
      factoryName: "scarif",
      worktreePath: over?.worktreePath === undefined ? dir : over.worktreePath,
      branchName: "minifac/scarif-abcdef",
      startedAt: Date.now() - 10_000,
    });
    await store.recordNodeStart(RUN_ID, "plan", 1, Date.now() - 9_000);
    await store.recordNodeEnd(RUN_ID, "plan", 1, { status: "succeeded", at: Date.now() - 8_000 });
    await store.recordNodeStart(RUN_ID, "evaluate", 1, Date.now() - 7_000);
    await store.appendEvent(RUN_ID, {
      nodeId: "evaluate",
      iteration: 1,
      kind: "status",
      payload: {
        kind: "status",
        status: "failed",
        meta: { reason: "sentinel_failed", sentinel: "escalate: AC-13 cannot be proved pre-merge" },
      },
      emittedAt: 3_000,
    });
    await store.recordNodeEnd(RUN_ID, "evaluate", 1, { status: "failed", at: Date.now() - 6_000 });
    await store.finalizeRun(RUN_ID, {
      status: "failed",
      reason: "node_failed",
      proximateNodeId: "evaluate",
      endedAt: Date.now() - 6_000,
    });
    await store.close();
  }

  async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out = new BufferStream();
    const err = new BufferStream();
    const code = await runCli(args, {
      stdout: out,
      stderr: err,
      runCwd: dir,
      buildRegistry: fakeRegistry(),
      openRunStore,
    });
    return { code, out: out.text(), err: err.text() };
  }

  // TS-4 / AC-4
  it("continues the same run row, appends node executions, and creates no worktree", async () => {
    await seedParkedRun();
    const answerPath = path.join(dir, "answer.txt");
    await writeFile(answerPath, "waive AC-13, verify after deploy", "utf8");

    const { code, out } = await run([
      "run",
      "--resume",
      "abcdef",
      "--at",
      "evaluate",
      "--feedback",
      answerPath,
    ]);

    expect(code).toBe(0);
    expect(out).toContain("Resuming run abcdef01 (scarif) at node `evaluate`");

    // ONE run row, back to a terminal state under the SAME id.
    const store = SqliteRunStore.open(dbPath);
    const rows = await store.listRuns({ limit: 100 });
    expect(rows.map((r) => r.id)).toEqual([RUN_ID]);
    expect(rows[0]?.status).toBe("succeeded");

    // The resumed dispatch is appended as iteration 2 of evaluate; plan is untouched.
    const execs = await store.getNodeExecutions(RUN_ID);
    expect(execs.map((e) => `${e.nodeId}#${e.iteration}:${e.status}`).sort()).toEqual([
      "evaluate#1:failed",
      "evaluate#2:succeeded",
      "plan#1:succeeded",
    ]);
    await store.close();

    // Only the resumed node ran, and it got the answer both ways.
    expect(prompts.map((p) => p.nodeId)).toEqual(["evaluate"]);
    expect(prompts[0]?.prompt).toContain("answer=[waive AC-13, verify after deploy]");
    expect(prompts[0]?.prompt).toContain("## Human answer (resume)");

    // No worktree was cut.
    const home = await readdir(path.join(dir, "home")).catch(() => []);
    expect(home).not.toContain("worktrees");
  });

  it("resumes without --feedback, leaving the token empty", async () => {
    await seedParkedRun();

    const { code } = await run(["run", "--resume", RUN_ID, "--at", "evaluate"]);

    expect(code).toBe(0);
    expect(prompts[0]?.prompt).toContain("answer=[]");
    expect(prompts[0]?.prompt).not.toContain("## Human answer (resume)");
  });

  it("refuses a missing --at, naming what is missing", async () => {
    await seedParkedRun();
    const { code, err } = await run(["run", "--resume", "abcdef"]);
    expect(code).toBe(1);
    expect(err).toContain("--resume requires --at <node>");
  });

  it("refuses an unknown run", async () => {
    await seedParkedRun();
    const { code, err } = await run(["run", "--resume", "999999", "--at", "evaluate"]);
    expect(code).toBe(1);
    expect(err).toContain("No run matches run-id prefix `999999`");
  });

  it("refuses a non-prefix-shaped run reference", async () => {
    await seedParkedRun();
    const { code, err } = await run(["run", "--resume", "some-change", "--at", "evaluate"]);
    expect(code).toBe(1);
    expect(err).toMatch(/not a run id or a run-id prefix/);
  });

  it("refuses an ambiguous prefix, listing the matches", async () => {
    await seedParkedRun();
    const store = SqliteRunStore.open(dbPath);
    await store.createRun({
      id: "abcdef99-0000-0000-0000-000000000000",
      factoryPath,
      factoryName: "scarif",
      startedAt: Date.now(),
    });
    await store.close();

    const { code, err } = await run(["run", "--resume", "abcdef", "--at", "evaluate"]);
    expect(code).toBe(1);
    expect(err).toContain("is ambiguous; matches:");
    expect(err).toContain(RUN_ID);
  });

  it("refuses an unknown --at, listing the factory's nodes", async () => {
    await seedParkedRun();
    const { code, err } = await run(["run", "--resume", "abcdef", "--at", "nope"]);
    expect(code).toBe(1);
    expect(err).toContain("`--at nope` names no node in factory `scarif`");
    expect(err).toContain("plan, evaluate");
  });

  it("refuses an unreadable feedback file", async () => {
    await seedParkedRun();
    const { code, err } = await run([
      "run",
      "--resume",
      "abcdef",
      "--at",
      "evaluate",
      "--feedback",
      path.join(dir, "no-such-answer.txt"),
    ]);
    expect(code).toBe(1);
    expect(err).toContain("Could not read the feedback file");
  });

  it("refuses a run whose worktree is gone", async () => {
    await seedParkedRun({ worktreePath: path.join(dir, "vanished") });
    const { code, err } = await run(["run", "--resume", "abcdef", "--at", "evaluate"]);
    expect(code).toBe(1);
    expect(err).toMatch(/recorded its worktree at .*vanished, which is gone/);
  });

  it("refuses --resume together with a brief or factory argument", async () => {
    await seedParkedRun();
    const { code, err } = await run(["run", "--resume", "abcdef", "--at", "evaluate", "scarif"]);
    expect(code).toBe(1);
    expect(err).toContain("--resume takes a run, not a brief or factory argument");
  });

  it("refuses --at without --resume", async () => {
    const { code, err } = await run(["run", "--in-place", "--at", "evaluate", "scarif"]);
    expect(code).toBe(1);
    expect(err).toContain("--at and --feedback are only meaningful with --resume");
  });

  it("refuses run with neither an argument nor --resume", async () => {
    const { code, err } = await run(["run"]);
    expect(code).toBe(1);
    expect(err).toMatch(/needs a brief path, brief name, or factory name/);
  });
});
