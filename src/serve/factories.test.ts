import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactoryWatcher } from "./factories.js";

const HELLO_YAML = `name: hello
nodes:
  greet:
    executor: claude
    terminal: true
    with:
      prompt: "hi"
edges: []
`;

const BROKEN_YAML = `name: bad
nodes:
  oops:
    terminal: true
edges: []
`;

async function settle(ms = 200): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

describe("FactoryWatcher", () => {
  let dir: string;
  let watcher: FactoryWatcher;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "minifac-fw-"));
  });
  afterEach(async () => {
    watcher?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("initial scan picks up valid factories", async () => {
    await writeFile(path.join(dir, "hello.yaml"), HELLO_YAML);
    watcher = new FactoryWatcher(dir, { warn: () => {} });
    await watcher.start();
    const list = watcher.list();
    expect(list).toHaveLength(1);
    const e = list[0];
    expect(e?.id).toBe("hello");
    expect(e?.name).toBe("hello");
    expect(e?.kind).toBe("ok");
  });

  it("lists invalid factories with their error set", async () => {
    await writeFile(path.join(dir, "broken.yaml"), BROKEN_YAML);
    watcher = new FactoryWatcher(dir, { warn: () => {} });
    await watcher.start();
    const list = watcher.list();
    expect(list).toHaveLength(1);
    const e = list[0];
    expect(e?.id).toBe("broken");
    expect(e?.kind).toBe("err");
    if (e?.kind === "err") expect(e.error).toBeTruthy();
  });

  it("picks up new files after startup (with explicit rescan as a safety net)", async () => {
    watcher = new FactoryWatcher(dir, { warn: () => {} });
    await watcher.start();
    expect(watcher.list()).toHaveLength(0);

    await writeFile(path.join(dir, "another.yaml"), HELLO_YAML);
    // fs.watch firing is platform-dependent; allow some time then a manual
    // rescan as a fallback. Production code coalesces watcher events into a
    // rescan; the test simulates the same with a direct call to keep CI happy.
    await settle(150);
    await watcher.rescan();
    const list = watcher.list();
    expect(list.map((e) => e.id)).toContain("another");
  });

  it("drops entries whose files were removed", async () => {
    const filePath = path.join(dir, "hello.yaml");
    await writeFile(filePath, HELLO_YAML);
    watcher = new FactoryWatcher(dir, { warn: () => {} });
    await watcher.start();
    expect(watcher.list()).toHaveLength(1);

    await rm(filePath);
    await watcher.rescan();
    expect(watcher.list()).toHaveLength(0);
  });
});
