import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunArgResolutionError, resolveFactoryByName, resolveRunArg } from "../cli/resolve.js";
import { FactoryLoadError, loadFactory } from "../factory/loader.js";
import { _clearLibraryMemo, loadProjectLayout } from "./library.js";

// A local bare repository stands in for the library remote: no network.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, env: GIT_ENV, encoding: "utf8" },
  ).trim();
}

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

const REVIEW_STEP = `name: review
version: "0.1.0"
inputs:
  jira_key: { type: string, required: true }
executor: claude
with:
  prompt: "library review {{ inputs.jira_key }}"
  allowed_tools: [Read]
`;

const PLAN_STEP = `name: plan
version: "0.1.0"
inputs:
  jira_key: { type: string, required: true }
executor: claude
with:
  prompt: "library plan {{ inputs.jira_key }}"
`;

const STANDARD_WORKFLOW = `name: standard
brief: none
nodes:
  plan:
    uses: plan
    inputs: { jira_key: "K-1" }
  review:
    uses: review
    terminal: true
    inputs: { jira_key: "K-1" }
edges:
  - from: plan
    to: review
`;

interface Library {
  /** Absolute path of the bare "remote". */
  remote: string;
  /** Working clone used to author commits and tags. */
  work: string;
  /** sha of the commit tagged v0.1.0. */
  v1: string;
}

async function makeLibrary(root: string): Promise<Library> {
  const work = path.join(root, "lib-work");
  const remote = path.join(root, "lib-remote.git");
  await mkdir(work, { recursive: true });
  git(work, "init", "--quiet");
  await writeAt(work, "steps/review.yaml", REVIEW_STEP);
  await writeAt(work, "steps/plan.yaml", PLAN_STEP);
  await writeAt(work, "workflows/standard.yaml", STANDARD_WORKFLOW);
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "v0.1.0");
  git(work, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
  const v1 = git(work, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--bare", work, remote);
  git(work, "remote", "add", "origin", remote);
  return { remote, work, v1 };
}

/** A factory repo: `factory.yaml` pinning the library, plus local files. */
async function makeConsumer(root: string, repo: string, ref: string): Promise<string> {
  const dir = path.join(root, "consumer");
  await mkdir(dir, { recursive: true });
  // Quoted, so an all-digit sha prefix stays a string (YAML would read it as a number).
  await writeAt(dir, "factory.yaml", `name: c\nlibrary:\n  repo: ${repo}\n  ref: "${ref}"\n`);
  return dir;
}

let root: string;
let prevHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "minifac-library-"));
  prevHome = process.env.MINIFAC_HOME;
  process.env.MINIFAC_HOME = path.join(root, "home");
  _clearLibraryMemo();
});

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "MINIFAC_HOME");
  else process.env.MINIFAC_HOME = prevHome;
  vi.restoreAllMocks();
});

describe("library pin validation", () => {
  it("resolves a tag to its commit sha", async () => {
    const lib = await makeLibrary(root);
    const layout = await loadProjectLayout(await makeConsumer(root, lib.remote, "v0.1.0"));
    expect(layout.library?.sha).toBe(lib.v1);
    expect(layout.library?.ref).toBe("v0.1.0");
    expect(layout.factoryRepo).toBe(true);
  });

  it("accepts a full 40-character sha", async () => {
    const lib = await makeLibrary(root);
    const layout = await loadProjectLayout(await makeConsumer(root, lib.remote, lib.v1));
    expect(layout.library?.sha).toBe(lib.v1);
  });

  it("refuses a branch name, naming the non-immutable ref", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "main");
    await expect(loadProjectLayout(consumer)).rejects.toThrow(
      /`library\.ref: main`.*names a branch.*not an immutable pin/s,
    );
  });

  it("refuses an abbreviated sha", async () => {
    const lib = await makeLibrary(root);
    const short = lib.v1.slice(0, 7);
    const consumer = await makeConsumer(root, lib.remote, short);
    await expect(loadProjectLayout(consumer)).rejects.toThrow(
      new RegExp(`library\\.ref: ${short}.*abbreviated commit sha`, "s"),
    );
  });

  it.each(["HEAD", "main~1", "refs/tags/v0.1.0", "-v1"])(
    "refuses `%s` before touching the remote",
    async (ref) => {
      const consumer = await makeConsumer(root, path.join(root, "no-such-remote.git"), ref);
      await expect(loadProjectLayout(consumer)).rejects.toThrow(/is not an immutable pin/);
    },
  );

  it("refuses an unquoted all-digit ref (YAML number) as an abbreviated sha", async () => {
    const dir = path.join(root, "numeric");
    await mkdir(dir, { recursive: true });
    await writeAt(
      dir,
      "factory.yaml",
      `name: c\nlibrary:\n  repo: ${path.join(root, "no-such-remote.git")}\n  ref: 2107410\n`,
    );
    await expect(loadProjectLayout(dir)).rejects.toThrow(
      /`library\.ref: 2107410`.*abbreviated commit sha.*not an immutable pin/s,
    );
  });

  it("refuses a library declared in both factory.yaml and .minifac/config.yaml", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    await writeAt(
      consumer,
      ".minifac/config.yaml",
      `library:\n  repo: ${lib.remote}\n  ref: v0.1.0\n`,
    );
    await expect(loadProjectLayout(consumer)).rejects.toThrow(/declared in both/);
  });

  it("refuses a tag that moved after it was first resolved", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    await loadProjectLayout(consumer);
    await writeAt(lib.work, "steps/review.yaml", `${REVIEW_STEP}# moved\n`);
    git(lib.work, "commit", "--quiet", "-am", "moved");
    git(lib.work, "tag", "-f", "-a", "v0.1.0", "-m", "moved");
    git(lib.work, "push", "--quiet", "--force", "origin", "refs/tags/v0.1.0");
    _clearLibraryMemo();
    await expect(loadProjectLayout(consumer)).rejects.toThrow(
      new RegExp(`tag v0\\.1\\.0 .*now points at .*resolved to ${lib.v1}`, "s"),
    );
  });
});

describe("library cache", () => {
  it("materializes each resolved sha once, content-addressed, without .git", async () => {
    const lib = await makeLibrary(root);
    const first = await loadProjectLayout(await makeConsumer(root, lib.remote, "v0.1.0"));
    const libRoot = first.library?.root ?? "";
    expect(path.basename(libRoot)).toBe(lib.v1);
    expect(libRoot.startsWith(path.join(root, "home", "cache", "library"))).toBe(true);
    expect((await readdir(libRoot)).sort()).toEqual(["steps", "workflows"]);
    _clearLibraryMemo();
    const second = await loadProjectLayout(path.join(root, "consumer"));
    expect(second.library?.root).toBe(libRoot);
  });

  it("serves a warm cache when the remote is unreachable, with a warning", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    await loadProjectLayout(consumer);
    await rename(lib.remote, `${lib.remote}.gone`);
    _clearLibraryMemo();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const layout = await loadProjectLayout(consumer);
    expect(layout.library?.sha).toBe(lib.v1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not be reached.*using cached v0\.1\.0/);
  });

  it("fails loudly on a cold cache with no reachable remote, naming the ref", async () => {
    const consumer = await makeConsumer(root, path.join(root, "no-such-remote.git"), "v0.1.0");
    await expect(loadProjectLayout(consumer)).rejects.toThrow(
      /`library\.ref: v0\.1\.0`.*could not be fetched and nothing is cached/s,
    );
  });

  it("fails a stale tag pin naming the pinned ref and the remote head", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    await loadProjectLayout(consumer);
    git(lib.remote, "tag", "-d", "v0.1.0");
    _clearLibraryMemo();
    await expect(loadProjectLayout(consumer)).rejects.toThrow(
      new RegExp(`library\\.ref: v0\\.1\\.0.*is stale.*main at ${lib.v1}`, "s"),
    );
  });

  it("fails a stale sha pin once no branch or tag reaches it", async () => {
    const lib = await makeLibrary(root);
    git(lib.work, "checkout", "--quiet", "-b", "scratch");
    await writeAt(lib.work, "steps/extra.yaml", PLAN_STEP.replace("name: plan", "name: extra"));
    git(lib.work, "add", ".");
    git(lib.work, "commit", "--quiet", "-m", "scratch");
    const scratch = git(lib.work, "rev-parse", "HEAD");
    git(lib.work, "push", "--quiet", "origin", "scratch");
    const consumer = await makeConsumer(root, lib.remote, scratch);
    expect((await loadProjectLayout(consumer)).library?.sha).toBe(scratch);
    git(lib.remote, "branch", "-D", "scratch");
    _clearLibraryMemo();
    await expect(loadProjectLayout(consumer)).rejects.toThrow(
      new RegExp(`library\\.ref: ${scratch}.*is stale.*latest tag v0\\.1\\.0`, "s"),
    );
  });
});

describe("loadFactory with a library", () => {
  it("resolves `extends: library:<name>` and the library workflow's bare `uses:` from the pin", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    // Same name as the base: the F1 case.
    const file = await writeAt(consumer, "workflows/standard.yaml", "extends: library:standard\n");
    const loaded = await loadFactory(file, consumer);
    expect(Object.keys(loaded.factory.nodes)).toEqual(["plan", "review"]);
    expect(loaded.factory.nodes.review?.with?.prompt).toBe("library review K-1");
    expect(loaded.library).toEqual({ repo: lib.remote, ref: "v0.1.0", sha: lib.v1 });
  });

  it("resolves `uses: library:<step>` from the pin", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    const file = await writeAt(
      consumer,
      "workflows/one.yaml",
      `name: one
brief: none
nodes:
  r:
    uses: library:review
    terminal: true
    inputs: { jira_key: "K-2" }
edges: []
`,
    );
    const loaded = await loadFactory(file, consumer);
    expect(loaded.factory.nodes.r?.with?.prompt).toBe("library review K-2");
  });

  it("a factory `steps/<name>.yaml` replaces the library step wholly", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    await writeAt(
      consumer,
      "steps/review.yaml",
      `name: review
version: "0.1.0"
inputs:
  jira_key: { type: string, required: true }
executor: claude
with:
  prompt: "factory review {{ inputs.jira_key }}"
`,
    );
    const file = await writeAt(consumer, "workflows/standard.yaml", "extends: library:standard\n");
    const { factory } = await loadFactory(file, consumer);
    expect(factory.nodes.review?.with).toEqual({ prompt: "factory review K-1" });
    // No field of the library step survives (allowed_tools was library-only).
    expect(factory.nodes.review?.with?.allowed_tools).toBeUndefined();
    // Untouched steps still come from the library.
    expect(factory.nodes.plan?.with?.prompt).toBe("library plan K-1");
  });

  it("a local step also replaces an explicit `uses: library:<step>`", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    await writeAt(
      consumer,
      ".minifac/steps/review.yaml",
      `name: review
version: "0.0.1"
inputs:
  jira_key: { type: string, required: true }
executor: claude
with:
  prompt: "local review"
`,
    );
    const file = await writeAt(
      consumer,
      "workflows/one.yaml",
      `name: one
brief: none
nodes:
  r:
    uses: library:review
    terminal: true
    inputs: { jira_key: "K-3" }
edges: []
`,
    );
    const { factory } = await loadFactory(file, consumer);
    expect(factory.nodes.r?.with?.prompt).toBe("local review");
  });

  it("an unknown library step is a load error naming the namespace and the pin", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    const file = await writeAt(
      consumer,
      "workflows/one.yaml",
      `name: one
brief: none
nodes:
  r:
    uses: library:nope
    terminal: true
edges: []
`,
    );
    const err = await loadFactory(file, consumer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FactoryLoadError);
    expect((err as Error).message).toMatch(
      new RegExp(
        `library:nope.*no step \`nope\` in the library .*@v0\\.1\\.0 \\(${lib.v1.slice(0, 12)}\\)`,
        "s",
      ),
    );
  });

  it("an unknown library workflow is a load error naming the namespace and the pin", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    const file = await writeAt(consumer, "workflows/x.yaml", "extends: library:nope\n");
    await expect(loadFactory(file, consumer)).rejects.toThrow(
      /extends: library:nope.*no workflow `nope` in the library .*@v0\.1\.0/s,
    );
  });

  it("`library:` with no library declared is a load error", async () => {
    const consumer = path.join(root, "plain");
    const file = await writeAt(
      consumer,
      ".minifac/factories/x.yaml",
      "extends: library:standard\n",
    );
    await expect(loadFactory(file, consumer)).rejects.toThrow(/declares no library/);
  });

  it("a branch pin fails the load before any artifact resolves", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "main");
    const file = await writeAt(consumer, "workflows/standard.yaml", "extends: library:standard\n");
    const err = await loadFactory(file, consumer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FactoryLoadError);
    expect((err as FactoryLoadError).sourcePath).toBe(file);
    expect((err as Error).message).toMatch(/library\.ref: main.*names a branch/s);
  });

  it("a `.minifac/config.yaml` declaration works outside a factory repo", async () => {
    const lib = await makeLibrary(root);
    const consumer = path.join(root, "plain");
    await writeAt(
      consumer,
      ".minifac/config.yaml",
      `library:\n  repo: ${lib.remote}\n  ref: v0.1.0\n`,
    );
    const file = await writeAt(
      consumer,
      ".minifac/factories/standard.yaml",
      "extends: library:standard\n",
    );
    const loaded = await loadFactory(file, consumer);
    expect(loaded.library?.sha).toBe(lib.v1);
    // Root `steps/` is not a local layer without factory.yaml.
    expect((await loadProjectLayout(consumer)).factoryRepo).toBe(false);
  });
});

describe("factory-by-name resolution with a library", () => {
  it("falls back to the library's workflows/<name>.yaml when nothing local matches", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "v0.1.0");
    const resolved = await resolveFactoryByName("standard", consumer);
    const libRoot = (await loadProjectLayout(consumer)).library?.root ?? "";
    expect(resolved).toBe(path.join(libRoot, "workflows", "standard.yaml"));
    // A factory workflow of the same name wins over the library's.
    const local = await writeAt(consumer, "workflows/standard.yaml", "extends: library:standard\n");
    expect(await resolveFactoryByName("standard", consumer)).toBe(local);
  });

  it("a bad pin surfaces as the pin error, not as a missing factory", async () => {
    const lib = await makeLibrary(root);
    const consumer = await makeConsumer(root, lib.remote, "main");
    const err = await resolveRunArg("standard", consumer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunArgResolutionError);
    expect((err as Error).message).toMatch(/library\.ref: main.*names a branch/s);
  });
});

// SCARIFW-1632 (L-b): an embedder lends library git a credential through
// `loadFactory(..., { env })` instead of mutating its own process.env. Here the
// declared remote does not exist; only a `GIT_CONFIG_*` insteadOf in `env`
// rewrites it to the real (local) remote, so resolution succeeds only if the env
// reaches the git child.
describe("library git env option", () => {
  function rewriteEnv(from: string, to: string): NodeJS.ProcessEnv {
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${to}.insteadOf`,
      GIT_CONFIG_VALUE_0: from,
    };
  }

  it("resolves a library through a remote reachable only via the env option, leaving process.env unchanged", async () => {
    const lib = await makeLibrary(root);
    const unreachable = `file://${path.join(root, "no-such-remote", "lib.git")}`;
    const consumer = await makeConsumer(root, unreachable, "v0.1.0");
    const file = await writeAt(consumer, "workflows/standard.yaml", "extends: library:standard\n");
    const env = rewriteEnv(unreachable, `file://${lib.remote}`);
    const before = { ...process.env };

    // Without the option the remote cannot be reached and nothing is cached.
    await expect(loadFactory(file, consumer)).rejects.toThrow(
      /could not be fetched and nothing is cached/,
    );
    expect(process.env).toEqual(before);

    // The failure was not memoized: the same pin resolves once the env is lent.
    const loaded = await loadFactory(file, consumer, { env });
    expect(loaded.library).toEqual({ repo: unreachable, ref: "v0.1.0", sha: lib.v1 });
    expect(loaded.factory.nodes.review?.with?.prompt).toBe("library review K-1");
    expect(process.env).toEqual(before);
    expect(Object.keys(process.env).filter((k) => k.startsWith("GIT_CONFIG_"))).toEqual(
      Object.keys(before).filter((k) => k.startsWith("GIT_CONFIG_")),
    );
  });

  it("loadProjectLayout passes the env to the fetch of an already-mirrored library", async () => {
    const lib = await makeLibrary(root);
    const unreachable = `file://${path.join(root, "no-such-remote", "lib.git")}`;
    const consumer = await makeConsumer(root, unreachable, "v0.1.0");
    const env = rewriteEnv(unreachable, `file://${lib.remote}`);
    await loadProjectLayout(consumer, { env });

    // A new tag on the real remote is visible only if the refresh fetch got the env.
    git(lib.work, "commit", "--quiet", "--allow-empty", "-m", "v0.2.0");
    git(lib.work, "tag", "-a", "v0.2.0", "-m", "v0.2.0");
    git(lib.work, "push", "--quiet", "origin", "main", "v0.2.0");
    const v2 = git(lib.work, "rev-parse", "HEAD");
    _clearLibraryMemo();
    await writeAt(
      consumer,
      "factory.yaml",
      `name: c\nlibrary:\n  repo: ${unreachable}\n  ref: "v0.2.0"\n`,
    );
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    const layout = await loadProjectLayout(consumer, { env });
    expect(layout.library?.sha).toBe(v2);
    expect(warn).not.toHaveBeenCalled();
  });
});
