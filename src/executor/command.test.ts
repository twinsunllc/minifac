import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Factory } from "../factory/schema.js";
import { CommandExecutor, type CommandRecord, validateCommandWith } from "./command.js";
import type { NodeEvent, RunContext } from "./types.js";

const FACTORY: Factory = { name: "t", brief: "none", nodes: {}, edges: [] };

let dir: string;
let outputsDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "minifac-command-"));
  outputsDir = path.join(dir, "out");
  await mkdir(outputsDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Outcome {
  events: NodeEvent[];
  status: "succeeded" | "failed" | undefined;
  meta: Record<string, unknown>;
  result: { commands: CommandRecord[]; [k: string]: unknown };
}

async function runNode(
  withValue: Record<string, unknown>,
  opts: { executor?: CommandExecutor; ctx?: Partial<RunContext> } = {},
): Promise<Outcome> {
  const executor = opts.executor ?? new CommandExecutor({ killGraceMs: 200 });
  const ctx: RunContext = {
    factory: FACTORY,
    priorResults: [],
    nodeId: "n",
    iteration: 1,
    cwd: dir,
    outputsDir,
    ...opts.ctx,
  };
  const events: NodeEvent[] = [];
  for await (const e of executor.run({ id: "n", executor: "command", with: withValue }, ctx)) {
    events.push(e);
  }
  const last = [...events].reverse().find((e) => e.kind === "status" && e.status !== "started");
  const status = last?.kind === "status" ? (last.status as "succeeded" | "failed") : undefined;
  const meta = (last?.kind === "status" ? last.meta : {}) as Record<string, unknown>;
  let result = { commands: [] as CommandRecord[] };
  try {
    result = JSON.parse(await readFile(path.join(outputsDir, "result.json"), "utf8"));
  } catch {
    // no result.json (invalid_with)
  }
  return { events, status, meta, result };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe("CommandExecutor", () => {
  it("declares no MCP, nudge or resume support", () => {
    const ex = new CommandExecutor();
    expect(ex.type).toBe("command");
    expect([ex.supportsMcp, ex.supportsNudge, ex.supportsResume]).toEqual([false, false, false]);
  });

  it("all green: succeeds with one result entry per command", async () => {
    const out = await runNode({
      commands: [
        { id: "a", run: "echo hello; echo oops >&2" },
        { id: "b", run: "exit 0" },
      ],
    });
    expect(out.status).toBe("succeeded");
    expect(out.result.commands.map((c) => c.id)).toEqual(["a", "b"]);
    const a = out.result.commands[0];
    expect(a).toMatchObject({
      id: "a",
      exit_code: 0,
      host_missing: false,
      timed_out: false,
      met: true,
      stdout_tail: "hello\n",
      stderr_tail: "oops\n",
    });
    expect(typeof a?.duration_ms).toBe("number");
    expect(out.events).toContainEqual({ kind: "stdout", line: "hello" });
    expect(out.events).toContainEqual({ kind: "stderr", line: "oops" });
  });

  it("stops at the first red command by default", async () => {
    const out = await runNode({
      commands: [
        { id: "one", run: "true" },
        { id: "two", run: "exit 1" },
        { id: "three", run: "echo ran > three.txt" },
      ],
    });
    expect(out.status).toBe("failed");
    expect(out.result.commands.map((c) => c.id)).toEqual(["one", "two"]);
    expect(out.meta.sentinel).toBe("two: exit 1, expected [0]");
    await expect(readFile(path.join(dir, "three.txt"), "utf8")).rejects.toThrow();
  });

  it("continue_on_red runs every command and still fails", async () => {
    const out = await runNode({
      continue_on_red: true,
      commands: [
        { id: "one", run: "true" },
        { id: "two", run: "exit 1" },
        { id: "three", run: "exit 0" },
      ],
    });
    expect(out.status).toBe("failed");
    expect(out.result.commands.map((c) => [c.id, c.met])).toEqual([
      ["one", true],
      ["two", false],
      ["three", true],
    ]);
  });

  it("an expect.exit list makes any listed code green", async () => {
    const out = await runNode({
      commands: [
        { id: "one", run: "true" },
        { id: "two", run: "exit 1", expect: { exit: [0, 1] } },
        { id: "three", run: "exit 3", expect: { exit: 3 } },
      ],
    });
    expect(out.status).toBe("succeeded");
    expect(out.result.commands.map((c) => c.exit_code)).toEqual([0, 1, 3]);
  });

  it("bounds stdout and stderr tails to tailBytes", async () => {
    const out = await runNode({
      commands: [
        {
          id: "big",
          run: "i=0; while [ $i -lt 2000 ]; do echo line-$i; echo err-$i >&2; i=$((i+1)); done",
        },
      ],
    });
    const rec = out.result.commands[0];
    expect(Buffer.byteLength(rec?.stdout_tail ?? "")).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(rec?.stderr_tail ?? "")).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(rec?.stdout_tail ?? "")).toBeGreaterThan(8000);
    expect(rec?.stdout_tail.endsWith("line-1999\n")).toBe(true);
    expect(rec?.stderr_tail.endsWith("err-1999\n")).toBe(true);

    const small = await runNode(
      { commands: [{ id: "s", run: "printf '0123456789'" }] },
      { executor: new CommandExecutor({ tailBytes: 4 }) },
    );
    expect(small.result.commands[0]?.stdout_tail).toBe("6789");
  });

  it("never opens a tail mid-character", async () => {
    // "é" is two bytes; a 3-byte tail of "aéé" must drop the orphaned byte.
    const out = await runNode(
      { commands: [{ id: "u", run: "printf 'a\\303\\251\\303\\251'" }] },
      { executor: new CommandExecutor({ tailBytes: 3 }) },
    );
    expect(out.result.commands[0]?.stdout_tail).toBe("é");
  });

  describe("tool / host_missing", () => {
    it("is red, never spawned, and fails the node", async () => {
      const out = await runNode({
        commands: [
          {
            id: "lint",
            tool: "definitely-not-a-binary-xyz",
            run: "echo spawned > spawned.txt",
          },
        ],
      });
      expect(out.status).toBe("failed");
      expect(out.result.commands[0]).toMatchObject({
        id: "lint",
        host_missing: true,
        exit_code: null,
        met: false,
      });
      expect(out.meta.sentinel).toBe("lint: host_missing definitely-not-a-binary-xyz");
      await expect(readFile(path.join(dir, "spawned.txt"), "utf8")).rejects.toThrow();
    });

    it("is present and red under continue_on_red, not skipped", async () => {
      const out = await runNode({
        continue_on_red: true,
        commands: [
          { id: "a", tool: "definitely-not-a-binary-xyz", run: "true" },
          { id: "b", run: "true" },
        ],
      });
      expect(out.status).toBe("failed");
      expect(out.result.commands.map((c) => [c.id, c.host_missing, c.met])).toEqual([
        ["a", true, false],
        ["b", false, true],
      ]);
    });

    it("resolves a tool on PATH and a relative executable path", async () => {
      await mkdir(path.join(dir, "bin"));
      await writeFile(path.join(dir, "bin", "mytool"), "#!/bin/sh\necho mytool\n");
      await chmod(path.join(dir, "bin", "mytool"), 0o755);
      await writeFile(path.join(dir, "bin", "noexec"), "#!/bin/sh\n");
      const out = await runNode({
        continue_on_red: true,
        commands: [
          { id: "onpath", tool: "sh", run: "true" },
          { id: "rel", tool: "./bin/mytool", run: "./bin/mytool" },
          { id: "notexec", tool: "./bin/noexec", run: "true" },
        ],
      });
      expect(out.result.commands.map((c) => [c.id, c.host_missing, c.met])).toEqual([
        ["onpath", false, true],
        ["rel", false, true],
        ["notexec", true, false],
      ]);
    });
  });

  describe("process-group kill", () => {
    it("kills a timed-out command and its grandchild", async () => {
      const pidFile = path.join(dir, "pid");
      const started = Date.now();
      const out = await runNode({
        commands: [
          { id: "slow", run: `sleep 60 & echo $! > ${pidFile}; wait`, timeout_seconds: 1 },
        ],
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(out.status).toBe("failed");
      expect(out.result.commands[0]?.timed_out).toBe(true);
      expect(out.meta.sentinel).toBe("slow: timed out after 1s");
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(await waitFor(() => !alive(pid))).toBe(true);
    });

    it("sends SIGTERM first, so a command that handles it ends before the grace", async () => {
      const started = Date.now();
      const out = await runNode(
        {
          commands: [
            {
              id: "polite",
              run: "trap 'echo got-term; exit 0' TERM; sleep 60 & wait",
              timeout_seconds: 1,
            },
          ],
        },
        { executor: new CommandExecutor({ killGraceMs: 20_000 }) },
      );
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(out.result.commands[0]?.timed_out).toBe(true);
      expect(out.result.commands[0]?.stdout_tail).toBe("got-term\n");
      // Timed out is red even when the command then exits 0.
      expect(out.status).toBe("failed");
    });

    it("SIGKILLs a group that ignores SIGTERM after the grace", async () => {
      const pidFile = path.join(dir, "pid");
      const out = await runNode({
        commands: [
          {
            id: "stubborn",
            run: `trap '' TERM; sleep 60 & echo $! > ${pidFile}; wait; wait`,
            timeout_seconds: 1,
          },
        ],
      });
      expect(out.result.commands[0]?.timed_out).toBe(true);
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(await waitFor(() => !alive(pid))).toBe(true);
    });

    it("kills a grandchild a command backgrounded before exiting 0", async () => {
      const pidFile = path.join(dir, "pid");
      const out = await runNode({
        commands: [{ id: "bg", run: `sleep 60 & echo $! > ${pidFile}; exit 0` }],
      });
      expect(out.status).toBe("succeeded");
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(await waitFor(() => !alive(pid))).toBe(true);
    });

    it("kills the running command when the consumer stops iterating", async () => {
      const pidFile = path.join(dir, "pid");
      const ex = new CommandExecutor({ killGraceMs: 200 });
      const ctx: RunContext = {
        factory: FACTORY,
        priorResults: [],
        nodeId: "n",
        iteration: 1,
        cwd: dir,
        outputsDir,
      };
      const node = {
        id: "n",
        executor: "command",
        with: { commands: [{ id: "c", run: `sleep 60 & echo $! > ${pidFile}; echo up; wait` }] },
      };
      for await (const e of ex.run(node, ctx)) {
        if (e.kind === "stdout" && e.line === "up") break;
      }
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(await waitFor(() => !alive(pid))).toBe(true);
    });
  });

  describe("result_from / result_file", () => {
    it("merges a result_from command's JSON keys beside commands", async () => {
      const out = await runNode({
        result_from: "gate",
        commands: [
          {
            id: "gate",
            run: `echo '{"clears_when":"x","resume_on_revise":true}'`,
          },
        ],
      });
      expect(out.status).toBe("succeeded");
      expect(out.result.clears_when).toBe("x");
      expect(out.result.resume_on_revise).toBe(true);
      expect(out.result.commands).toHaveLength(1);
    });

    it("fails, naming the command, when result_from stdout is not JSON", async () => {
      const out = await runNode({
        result_from: "gate",
        commands: [{ id: "gate", run: "echo not json" }],
      });
      expect(out.status).toBe("failed");
      expect(String(out.meta.sentinel)).toMatch(/^result_parse: gate: /);
    });

    it("fails when result_from emits a non-object", async () => {
      const out = await runNode({
        result_from: "gate",
        commands: [{ id: "gate", run: "echo '[1,2]'" }],
      });
      expect(out.status).toBe("failed");
      expect(out.meta.sentinel).toBe("result_parse: gate: expected a JSON object, got array");
    });

    it("replaces an emitted `commands` key with the per-command list", async () => {
      const out = await runNode({
        result_from: "gate",
        commands: [{ id: "gate", run: `echo '{"commands":"mine","k":1}'` }],
      });
      expect(out.result.k).toBe(1);
      expect(Array.isArray(out.result.commands)).toBe(true);
      expect(out.events.some((e) => e.kind === "stderr" && e.line.includes("`commands`"))).toBe(
        true,
      );
    });

    it("merges a result_file under outputs_dir", async () => {
      const out = await runNode({
        result_file: "r.json",
        commands: [{ id: "w", run: `echo '{"verdict":"ok"}' > "$MINIFAC_OUTPUTS_DIR/r.json"` }],
      });
      expect(out.status).toBe("succeeded");
      expect(out.result.verdict).toBe("ok");
    });

    it("refuses a result_file that escapes outputs_dir", async () => {
      await writeFile(path.join(dir, "escape.json"), '{"x":1}');
      const out = await runNode({
        result_file: "../escape.json",
        commands: [{ id: "w", run: "true" }],
      });
      expect(out.status).toBe("failed");
      expect(out.meta.sentinel).toBe(
        "result_parse: ../escape.json: resolves outside run.outputs_dir",
      );
      expect(out.result.x).toBeUndefined();
    });

    it("refuses a result_file symlinked out of outputs_dir", async () => {
      const { symlink } = await import("node:fs/promises");
      await writeFile(path.join(dir, "escape.json"), '{"x":1}');
      await symlink(path.join(dir, "escape.json"), path.join(outputsDir, "link.json"));
      const out = await runNode({
        result_file: "link.json",
        commands: [{ id: "w", run: "true" }],
      });
      expect(out.status).toBe("failed");
      expect(out.meta.sentinel).toBe("result_parse: link.json: resolves outside run.outputs_dir");
    });

    it("fails when a result_file is missing after green commands", async () => {
      const out = await runNode({
        result_file: "absent.json",
        commands: [{ id: "w", run: "true" }],
      });
      expect(out.status).toBe("failed");
      expect(String(out.meta.sentinel)).toMatch(/^result_parse: absent\.json: ENOENT/);
    });
  });

  describe("reason", () => {
    it("the last REASON line a command printed is the failure reason", async () => {
      const out = await runNode({
        commands: [
          { id: "a", run: "echo 'REASON: first'; true" },
          { id: "b", run: "echo 'REASON: escalate: plan lists 40 files'; exit 1" },
        ],
      });
      expect(out.status).toBe("failed");
      expect(out.meta).toMatchObject({
        reason: "command_failed",
        sentinel: "escalate: plan lists 40 files",
      });
    });

    it("a REASON line does not fail a node whose commands all met expect", async () => {
      const out = await runNode({ commands: [{ id: "a", run: "echo 'REASON: nope'" }] });
      expect(out.status).toBe("succeeded");
    });

    it("plan_gate shape: exits non-zero with REASON and emitted keys", async () => {
      const out = await runNode({
        result_from: "gate",
        commands: [
          {
            id: "gate",
            run: `echo '{"clears_when":"a human approves","resume_on_revise":true}'; echo 'REASON: escalate: too big'; exit 1`,
          },
        ],
      });
      // The REASON line shares stdout with the JSON; result_from drops it
      // before parsing.
      expect(out.status).toBe("failed");
      expect(out.meta.sentinel).toBe("escalate: too big");
      expect(out.result.clears_when).toBe("a human approves");
      expect(out.result.resume_on_revise).toBe(true);
    });

    it("result_file: a gate writing its JSON to a file and REASON on stdout", async () => {
      const out = await runNode({
        result_file: "gate.json",
        commands: [
          {
            id: "gate",
            run: `echo '{"clears_when":"a human approves","resume_on_revise":true}' > "$MINIFAC_OUTPUTS_DIR/gate.json"; echo 'REASON: escalate: plan lists 40 files'; exit 1`,
          },
        ],
      });
      expect(out.status).toBe("failed");
      expect(out.meta.sentinel).toBe("escalate: plan lists 40 files");
      expect(out.result.clears_when).toBe("a human approves");
      expect(out.result.resume_on_revise).toBe(true);
    });

    it("an invalid with: fails before anything runs", async () => {
      const out = await runNode({ commands: [] });
      expect(out.status).toBe("failed");
      expect(out.meta.reason).toBe("invalid_with");
    });
  });
});

describe("validateCommandWith", () => {
  it.each([
    [{ commands: [] }, /^commands: commands must list at least one command$/],
    [
      {
        commands: [
          { id: "a", run: "x" },
          { id: "a", run: "y" },
        ],
      },
      /^commands\[1\]\.id: duplicate command id `a`$/,
    ],
    [{ commands: [{ id: "a", run: "x" }], result_from: "nope" }, /^result_from: .*`nope`/],
    [
      { commands: [{ id: "a", run: "x" }], result_from: "a", result_file: "r.json" },
      /^result_from: .*mutually exclusive/,
    ],
    [{ commands: [{ id: "a", run: "x", bogus: 1 }] }, /^commands\[0\]\.bogus: unknown key/],
    [{ commands: [{ id: "a" }] }, /^commands\[0\]\.run: /],
    [{ commands: [{ id: "a", run: "x" }], extra: true }, /^extra: unknown key/],
    [{ commands: [{ id: "a", run: "x", timeout_seconds: 0 }] }, /^commands\[0\]\.timeout_seconds/],
    [{ commands: [{ id: "a", run: "x", expect: { exit: [] } }] }, /^commands\[0\]\.expect\.exit/],
  ])("rejects %j", (withValue, re) => {
    expect(validateCommandWith(withValue)).toMatch(re);
  });

  it("accepts a full shape", () => {
    expect(
      validateCommandWith({
        continue_on_red: true,
        result_from: "b",
        secrets: ["TOKEN"],
        commands: [
          {
            id: "a",
            run: "x",
            cwd: "sub",
            timeout_seconds: 5,
            expect: { exit: [0, 1] },
            tool: "x",
          },
          { id: "b", run: "y" },
        ],
      }),
    ).toBeNull();
  });
});
