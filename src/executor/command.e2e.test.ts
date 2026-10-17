// runFactory-level tests for `executor: command`: real loader, real runner,
// real `/bin/sh` children. No executor doubles.

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { loadFactory } from "../factory/loader.js";
import { runFactory } from "../runner/run.js";
import { CommandExecutor } from "./command.js";
import { ExecutorRegistry } from "./registry.js";
import type { EmittedEvent } from "./types.js";

let repo: string;
let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "minifac-command-e2e-"));
  home = await mkdtemp(path.join(tmpdir(), "minifac-command-home-"));
  await mkdir(path.join(repo, "examples", "steps"), { recursive: true });
  savedHome = process.env.MINIFAC_HOME;
  process.env.MINIFAC_HOME = home;
});

afterEach(async () => {
  // biome-ignore lint/performance/noDelete: env var must be unset, not assigned undefined
  if (savedHome === undefined) delete process.env.MINIFAC_HOME;
  else process.env.MINIFAC_HOME = savedHome;
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function writeAt(rel: string, contents: string): Promise<string> {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

function registry(): ExecutorRegistry {
  const reg = new ExecutorRegistry();
  reg.register(new CommandExecutor({ killGraceMs: 200 }));
  return reg;
}

async function run(facYaml: string, runId: string) {
  const fac = await writeAt("fac.yaml", facYaml);
  const loaded = await loadFactory(fac, repo);
  const events: EmittedEvent[] = [];
  const result = await runFactory(loaded, {
    registry: registry(),
    runId,
    runCwd: repo,
    onEvent: (e) => events.push(e),
  });
  return { result, events, outputs: path.join(home, "outputs", runId) };
}

const NASTY = `a'b"c $(touch pwned) \`touch pwned2\` \${HOME}\nline2 ; touch pwned3`;

describe("executor: command through runFactory", () => {
  it("renders inputs into run as data: the exact bytes arrive and nothing executes", async () => {
    await writeAt(
      "examples/steps/echo-step.yaml",
      `name: echo-step
version: "1.0.0"
executor: command
inputs:
  title: { type: string, required: true }
with:
  result_file: "{{ run.outputs_dir }}/r.json"
  commands:
    - id: write
      cwd: "{{ run.outputs_dir }}"
      run: "printf '%s' {{ inputs.title }} > {{ run.outputs_dir }}/out.txt; pwd > cwd.txt; echo '{\\"ok\\":true}' > r.json"
`,
    );
    const { result, outputs } = await run(
      `name: f
nodes:
  echo:
    uses: minifac:echo-step
    inputs:
      title: ${JSON.stringify(NASTY)}
    terminal: true
    outputs:
      result: { type: value, required: true }
edges: []
`,
      "shell-safety",
    );
    expect(result.status).toBe("succeeded");
    const dir = path.join(outputs, "echo", "1");
    expect(await readFile(path.join(dir, "out.txt"), "utf8")).toBe(NASTY);
    // cwd rendered: `pwd` ran in the outputs dir.
    expect((await readFile(path.join(dir, "cwd.txt"), "utf8")).trim()).toBe(await realpathOf(dir));
    // result_file rendered and merged.
    const res = JSON.parse(await readFile(path.join(dir, "result.json"), "utf8"));
    expect(res.ok).toBe(true);
    // Nothing the input carried executed, in the repo or the outputs dir.
    for (const where of [repo, dir]) {
      const names = await readdir(where);
      expect(names.filter((n) => n.startsWith("pwned"))).toEqual([]);
    }
  });

  it("plan_gate shape: REASON becomes NodeResult.reason, keys land in result, on_failure routes", async () => {
    const { result, outputs } = await run(
      `name: f
nodes:
  gate:
    executor: command
    with:
      result_from: gate
      commands:
        - id: gate
          run: |
            echo '{"clears_when":"a human approves the 40-file plan","resume_on_revise":true}'
            echo 'REASON: escalate: plan lists 40 files'
            exit 1
    outputs:
      result: { type: value, required: true }
  after:
    executor: command
    terminal: true
    with:
      commands:
        - id: record
          run: "printf '%s|%s|%s' {{ priorResults.gate.status }} {{ priorResults.gate.reason }} {{ priorResults.gate.outputs.result }} > {{ run.outputs_dir }}/seen.txt"
edges:
  - { from: gate, to: after, when: on_failure }
`,
      "plan-gate",
    );
    expect(result.status).toBe("succeeded");
    expect(result.log.map((e) => [e.nodeId, e.status])).toEqual([
      ["gate", "failed"],
      ["after", "succeeded"],
    ]);
    const seen = await readFile(path.join(outputs, "after", "1", "seen.txt"), "utf8");
    const gateResult = path.join(outputs, "gate", "1", "result.json");
    expect(seen).toBe(`failed|escalate: plan lists 40 files|${gateResult}`);
    const res = JSON.parse(await readFile(gateResult, "utf8"));
    expect(res.clears_when).toBe("a human approves the 40-file plan");
    expect(res.resume_on_revise).toBe(true);
    expect(res.commands[0]).toMatchObject({ id: "gate", exit_code: 1, met: false });
  });

  it("without a REASON line the generated reason names the first red command", async () => {
    const { outputs } = await run(
      `name: f
nodes:
  checks:
    executor: command
    with:
      continue_on_red: true
      commands:
        - { id: lint, run: "exit 0" }
        - { id: test, run: "exit 2" }
        - { id: build, tool: definitely-not-a-binary-xyz, run: "true" }
  after:
    executor: command
    terminal: true
    with:
      commands:
        - id: record
          run: "printf '%s' {{ priorResults.checks.reason }} > {{ run.outputs_dir }}/seen.txt"
edges:
  - { from: checks, to: after, when: on_failure }
`,
      "generated-reason",
    );
    expect(await readFile(path.join(outputs, "after", "1", "seen.txt"), "utf8")).toBe(
      "test: exit 2, expected [0]",
    );
  });

  it("a declared result output is indexed for a succeeded node", async () => {
    const { result, outputs } = await run(
      `name: f
nodes:
  a:
    executor: command
    with:
      commands:
        - { id: one, run: "echo hi" }
    outputs:
      result: { type: value, required: true }
  b:
    executor: command
    terminal: true
    with:
      commands:
        - id: read
          run: "printf '%s' {{ priorResults.a.outputs.result:read }} > {{ run.outputs_dir }}/copy.json"
edges:
  - { from: a, to: b }
`,
      "indexed",
    );
    expect(result.status).toBe("succeeded");
    const copy = JSON.parse(await readFile(path.join(outputs, "b", "1", "copy.json"), "utf8"));
    expect(copy.commands[0]).toMatchObject({ id: "one", exit_code: 0, stdout_tail: "hi\n" });
  });
});

describe("CLI default registry", () => {
  class Buf extends Writable {
    text = "";
    _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
      this.text += chunk.toString();
      cb();
    }
  }

  it("resolves executor: command for a step-inlined node", async () => {
    await writeAt(
      "examples/steps/hello-cmd.yaml",
      `name: hello-cmd
version: "1.0.0"
executor: command
with:
  commands:
    - { id: say, run: "echo hello-from-command" }
`,
    );
    await writeAt(
      "examples/gate.yaml",
      `name: gate
brief: none
nodes:
  say:
    uses: minifac:hello-cmd
    terminal: true
edges: []
`,
    );
    const out = new Buf();
    const err = new Buf();
    const code = await runCli(["run", "--in-place", "gate"], {
      stdout: out,
      stderr: err,
      runCwd: repo,
    });
    expect(err.text).not.toContain("unknown_executor");
    expect(code).toBe(0);
    expect(out.text).toContain("hello-from-command");
    expect(err.text).toMatch(/\[status\] say iter=1: succeeded/);
  });
});

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  await stat(p);
  return await realpath(p);
}
