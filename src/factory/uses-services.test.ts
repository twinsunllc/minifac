import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _clearLibraryMemo } from "../library/library.js";
import { FactoryLoadError, loadFactory } from "./loader.js";

// Workflow `uses_services:` (SCARIFW-1531): accepted, carried, never
// inherited; and a factory repo's `factory.yaml` `services:` block does not
// affect loading.

async function writeAt(dir: string, rel: string, contents: string): Promise<string> {
  const full = path.join(dir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, "utf8");
  return full;
}

const NODES = `nodes:
  build:
    executor: tool
    with: { command: "true" }
  ship:
    executor: tool
    terminal: true
    with: { command: "true" }
edges:
  - from: build
    to: ship
`;

let root: string;
let prevHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "minifac-uses-services-"));
  prevHome = process.env.MINIFAC_HOME;
  process.env.MINIFAC_HOME = path.join(root, "home");
  _clearLibraryMemo();
});

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "MINIFAC_HOME");
  else process.env.MINIFAC_HOME = prevHome;
});

async function loadError(file: string, cwd: string): Promise<FactoryLoadError> {
  try {
    await loadFactory(file, cwd);
  } catch (err) {
    if (err instanceof FactoryLoadError) return err;
    throw err;
  }
  throw new Error("expected loadFactory to fail");
}

describe("workflow `uses_services:` through loadFactory", () => {
  it("loads a list and carries it on the resolved factory", async () => {
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      `name: w\nuses_services: [mysql, valkey]\n${NODES}`,
    );
    const loaded = await loadFactory(file, root);
    expect(loaded.factory.uses_services).toEqual(["mysql", "valkey"]);
  });

  it.each([
    ["a scalar", "uses_services: mysql", /Schema error at uses_services: .*list of service names/],
    ["an empty-string entry", `uses_services: [""]`, /Schema error at uses_services\.0: /],
    ["a non-string entry", "uses_services: [mysql, 7]", /Schema error at uses_services\.1: /],
    [
      "a map of service definitions",
      `uses_services:\n  mysql:\n    image: "mysql:8.4@sha256:abc"`,
      /Schema error at uses_services: .*list of service names/,
    ],
    [
      "a duplicate entry",
      "uses_services: [mysql, mysql]",
      /Schema error at uses_services\.1: duplicate service "mysql"/,
    ],
  ])("refuses %s, naming the workflow file and the key", async (_label, yaml, message) => {
    const file = await writeAt(root, ".minifac/factories/w.yaml", `name: w\n${yaml}\n${NODES}`);
    const err = await loadError(file, root);
    expect(err.sourcePath).toBe(file);
    expect(err.message).toMatch(message);
  });

  it("still refuses a workflow that defines `services:` itself", async () => {
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      `name: w\nservices:\n  mysql: { image: "mysql:8.4" }\n${NODES}`,
    );
    const err = await loadError(file, root);
    expect(err.sourcePath).toBe(file);
    expect(err.message).toMatch(/Unrecognized key.*services/);
  });
});

describe("`uses_services:` is not inherited through `extends:`", () => {
  async function base(uses: string): Promise<void> {
    await writeAt(root, ".minifac/factories/base.yaml", `name: base\n${uses}${NODES}`);
  }

  it("a derived workflow's own list loads with `extends:`", async () => {
    await base("");
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      "extends: base\nuses_services: [mysql]\n",
    );
    const loaded = await loadFactory(file, root);
    expect(loaded.factory.uses_services).toEqual(["mysql"]);
    expect(loaded.factory.name).toBe("base");
  });

  it("a base's list does not reach a derived workflow that omits the key", async () => {
    await base("uses_services: [mysql, valkey]\n");
    const file = await writeAt(root, ".minifac/factories/w.yaml", "extends: base\n");
    const loaded = await loadFactory(file, root);
    expect(loaded.factory.uses_services).toBeUndefined();
    expect("uses_services" in loaded.factory).toBe(false);
  });

  it("a derived list replaces the base's and is never merged with it", async () => {
    await base("uses_services: [mysql]\n");
    const file = await writeAt(
      root,
      ".minifac/factories/w.yaml",
      "extends: base\nuses_services: [valkey]\n",
    );
    const loaded = await loadFactory(file, root);
    expect(loaded.factory.uses_services).toEqual(["valkey"]);
  });

  it("the base itself, loaded directly, keeps its own list", async () => {
    await base("uses_services: [mysql]\n");
    const loaded = await loadFactory(path.join(root, ".minifac/factories/base.yaml"), root);
    expect(loaded.factory.uses_services).toEqual(["mysql"]);
  });

  it("an invalid list on a base is refused, naming the base file", async () => {
    await base("uses_services: mysql\n");
    const file = await writeAt(root, ".minifac/factories/w.yaml", "extends: base\n");
    const err = await loadError(file, root);
    expect(err.sourcePath).toBe(path.join(root, ".minifac/factories/base.yaml"));
    expect(err.message).toMatch(/Schema error at uses_services/);
  });
});

// scarif-spec `ec2-per-job-lane` design D5, the `services:` block in shape.
const D5_SERVICES = `services:
  mysql:
    image: mysql:8.4@sha256:0000000000000000000000000000000000000000000000000000000000000000
    command: [--lower-case-table-names=1, --mysql-native-password=ON,
              --sql-mode=NO_ENGINE_SUBSTITUTION, --innodb-flush-log-at-trx-commit=0,
              --sync-binlog=0, --skip-log-bin]
    env:
      MYSQL_ROOT_PASSWORD: devpassword
      MYSQL_DATABASE: ie10_system_test
    ports: [3306]
    tmpfs: [/var/lib/mysql]
    healthcheck:
      test: [mysqladmin, ping, -h, 127.0.0.1, -uroot, -pdevpassword, --silent]
      interval_seconds: 1
      timeout_seconds: 120
    job_env:
      SYSTEM_DATABASE_URL: mysql://root:devpassword@127.0.0.1:3306/ie10_system_test
      LEGACY_DB_USERNAME: root
      LEGACY_DB_PASSWORD: devpassword
  valkey:
    image: valkey/valkey:8.1@sha256:1111111111111111111111111111111111111111111111111111111111111111
    ports: [6379]
    healthcheck:
      test: [valkey-cli, ping]
`;

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

/** A local bare library repo tagged v0.1.0 with one workflow; returns remote + sha. */
async function makeLibrary(): Promise<{ remote: string; sha: string }> {
  const work = path.join(root, "lib-work");
  const remote = path.join(root, "lib-remote.git");
  await writeAt(work, "workflows/standard.yaml", `name: standard\nbrief: none\n${NODES}`);
  git(work, "init", "--quiet");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "v0.1.0");
  git(work, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
  const sha = git(work, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--bare", work, remote);
  return { remote, sha };
}

describe("factory.yaml `services:` is tolerated", () => {
  async function consumer(dirName: string, remote: string, extra: string): Promise<string> {
    const dir = path.join(root, dirName);
    await writeAt(
      dir,
      "factory.yaml",
      `name: c\nrepos: [owner/app]\n${extra}library:\n  repo: ${remote}\n  ref: "v0.1.0"\n`,
    );
    await writeAt(
      dir,
      "workflows/w.yaml",
      "extends: library:standard\nuses_services: [mysql, valkey]\n",
    );
    return dir;
  }

  it("loads a workflow in a repo whose factory.yaml carries D5's services: and a library pin", async () => {
    const lib = await makeLibrary();
    const withServices = await consumer("with-services", lib.remote, D5_SERVICES);
    const without = await consumer("without-services", lib.remote, "");

    const loaded = await loadFactory(path.join(withServices, "workflows/w.yaml"), withServices);
    const control = await loadFactory(path.join(without, "workflows/w.yaml"), without);

    expect(loaded.library?.sha).toBe(lib.sha);
    expect(loaded.library?.ref).toBe("v0.1.0");
    expect(loaded.factory.uses_services).toEqual(["mysql", "valkey"]);
    expect(loaded.factory).toEqual(control.factory);
    expect(loaded.library).toEqual(control.library);
  });
});
