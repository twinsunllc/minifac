import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { renderBrief } from "../brief/authoring.js";
import { loadBrief } from "../brief/loader.js";
import { type BriefCommandIO, briefCommandAction } from "./brief.js";

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

async function makeDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "minifac-brief-cli-"));
  await mkdir(path.join(d, "inputs"), { recursive: true });
  return d;
}

function nonTtyStdin(): NodeJS.ReadableStream & { isTTY?: boolean } {
  const s = new PassThrough() as PassThrough & { isTTY?: boolean };
  s.isTTY = false;
  s.end();
  return s;
}

function ttyStdin(): PassThrough & { isTTY?: boolean } {
  const s = new PassThrough() as PassThrough & { isTTY?: boolean };
  s.isTTY = true;
  return s;
}

function makeIO(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): {
  io: BriefCommandIO;
  stdout: BufferStream;
  stderr: BufferStream;
} {
  const stdout = new BufferStream();
  const stderr = new BufferStream();
  return { io: { stdin, stdout, stderr }, stdout, stderr };
}

const ALL_ANSWERS = {
  change: "demo",
  factory: "sdd",
  background: "Why.",
  what_to_do: "Do.",
  acceptance_criteria: "Tests pass.",
};

describe("briefCommandAction --from", () => {
  it("happy path with YAML", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "answers.yaml");
    await writeFile(
      fromPath,
      "change: demo\nfactory: sdd\nbackground: Why.\nwhat_to_do: Do.\nacceptance_criteria: Tests pass.\n",
      "utf8",
    );
    const { io, stdout } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({
      name: "demo",
      from: fromPath,
      cwd,
      io,
    });
    expect(code).toBe(0);
    const outPath = path.join(cwd, "inputs", "demo.md");
    const written = await readFile(outPath, "utf8");
    expect(written).toBe(renderBrief(ALL_ANSWERS));
    expect(stdout.text().trim()).toBe(outPath);
    const brief = await loadBrief(outPath, cwd);
    expect(brief.frontmatter.change).toBe("demo");
  });

  it("happy path with JSON", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "answers.json");
    await writeFile(fromPath, JSON.stringify(ALL_ANSWERS), "utf8");
    const { io } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({ name: "demo", from: fromPath, cwd, io });
    expect(code).toBe(0);
  });

  it("missing required answer → exit 1, names the id", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "missing.yaml");
    await writeFile(fromPath, "change: demo\nfactory: sdd\nbackground: B\nwhat_to_do: W\n", "utf8");
    const { io, stderr } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({ name: "demo", from: fromPath, cwd, io });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/missing required answer `acceptance_criteria`/);
  });

  it("unknown key → exit 1, names the id", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "unknown.yaml");
    await writeFile(
      fromPath,
      "change: demo\nfactory: sdd\nbackground: B\nwhat_to_do: W\nacceptance_criteria: A\nwat: nope\n",
      "utf8",
    );
    const { io, stderr } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({ name: "demo", from: fromPath, cwd, io });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/unknown answer `wat`/);
  });

  it("wrong-type value → exit 1", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "badtype.yaml");
    await writeFile(
      fromPath,
      "change: 42\nfactory: sdd\nbackground: B\nwhat_to_do: W\nacceptance_criteria: A\n",
      "utf8",
    );
    const { io, stderr } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({ name: "demo", from: fromPath, cwd, io });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/answer `change` must be a string/);
  });

  it("unsupported extension → exit 1", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "answers.toml");
    await writeFile(fromPath, "change = 'demo'\n", "utf8");
    const { io, stderr } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({ name: "demo", from: fromPath, cwd, io });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/\.yaml.*\.yml.*\.json/);
  });

  it("--out overrides destination", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "answers.yaml");
    await writeFile(
      fromPath,
      "change: demo\nfactory: sdd\nbackground: B\nwhat_to_do: W\nacceptance_criteria: A\n",
      "utf8",
    );
    const customOut = path.join(cwd, "custom-out.md");
    const { io } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({
      name: "demo",
      from: fromPath,
      out: customOut,
      cwd,
      io,
    });
    expect(code).toBe(0);
    const written = await readFile(customOut, "utf8");
    expect(written).toContain("change: demo");
  });

  it("existing destination without --force is a usage error", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "answers.yaml");
    await writeFile(
      fromPath,
      "change: demo\nfactory: sdd\nbackground: B\nwhat_to_do: W\nacceptance_criteria: A\n",
      "utf8",
    );
    const outPath = path.join(cwd, "inputs", "demo.md");
    await writeFile(outPath, "pre-existing\n", "utf8");
    const { io, stderr } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({ name: "demo", from: fromPath, cwd, io });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/Refusing to overwrite/);
    const after = await readFile(outPath, "utf8");
    expect(after).toBe("pre-existing\n");
  });

  it("--force overwrites", async () => {
    const cwd = await makeDir();
    const fromPath = path.join(cwd, "answers.yaml");
    await writeFile(
      fromPath,
      "change: demo\nfactory: sdd\nbackground: B\nwhat_to_do: W\nacceptance_criteria: A\n",
      "utf8",
    );
    const outPath = path.join(cwd, "inputs", "demo.md");
    await writeFile(outPath, "pre-existing\n", "utf8");
    const { io } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({
      name: "demo",
      from: fromPath,
      force: true,
      cwd,
      io,
    });
    expect(code).toBe(0);
    const after = await readFile(outPath, "utf8");
    expect(after).not.toBe("pre-existing\n");
  });
});

describe("briefCommandAction interactive", () => {
  it("happy path: drive stdin with canned answers", async () => {
    const cwd = await makeDir();
    const stdin = ttyStdin();
    const { io, stdout } = makeIO(stdin);
    const promise = briefCommandAction({ name: "demo", cwd, io });

    // Question 1 (change) → use the preset (blank input).
    stdin.write("\n");
    // Question 2 (factory) → blank uses default `sdd`.
    stdin.write("\n");
    // 3 background
    stdin.write("Why.\n");
    // 4 what_to_do
    stdin.write("Do.\n");
    // 5 out_of_scope (optional) → blank
    stdin.write("\n");
    // 6 acceptance_criteria
    stdin.write("Tests pass.\n");
    // 7 base_branch (optional) → blank
    stdin.write("\n");
    // 8 model (optional) → blank
    stdin.write("\n");

    const code = await promise;
    expect(code).toBe(0);
    const outPath = path.join(cwd, "inputs", "demo.md");
    const written = await readFile(outPath, "utf8");
    expect(written).toBe(renderBrief(ALL_ANSWERS));
    expect(stdout.text()).toContain(outPath);
  });

  it("stop after frontmatter writes a partial brief naming `background`", async () => {
    const cwd = await makeDir();
    const stdin = ttyStdin();
    const { io, stderr } = makeIO(stdin);
    const promise = briefCommandAction({ name: "demo", cwd, io });

    // change preset accepted, factory default accepted, then EOF
    stdin.write("\n");
    stdin.write("\n");
    stdin.end();

    const code = await promise;
    expect(code).toBe(0);
    const outPath = path.join(cwd, "inputs", "demo.md");
    const written = await readFile(outPath, "utf8");
    expect(written).toMatch(/> \*\*Note:\*\* Brief is incomplete/);
    expect(written).toMatch(/before the `background` question/);
    expect(stderr.text()).toMatch(/`background`/);
    const brief = await loadBrief(outPath, cwd);
    expect(brief.frontmatter.change).toBe("demo");
  });

  it("stop before required frontmatter writes nothing and exits non-zero", async () => {
    const cwd = await makeDir();
    const stdin = ttyStdin();
    const { io, stderr } = makeIO(stdin);
    // Override the change preset to require typed input.
    const promise = briefCommandAction({ name: "", cwd, io });
    stdin.end(); // immediate EOF
    const code = await promise;
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/missing required frontmatter/);
    // No file was written
    await expect(readFile(path.join(cwd, "inputs", ".md"), "utf8")).rejects.toThrow();
  });

  it("non-TTY without --from is a usage error", async () => {
    const cwd = await makeDir();
    const { io, stderr } = makeIO(nonTtyStdin());
    const code = await briefCommandAction({ name: "demo", cwd, io });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/--from/);
  });
});
