import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LockHeldError, claimLock, probeLockLiveness } from "./lock.js";

async function makeDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "minifac-lock-"));
}

describe("claimLock", () => {
  it("creates a lockfile containing the current PID + newline", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    const handle = await claimLock(lock);
    const content = await readFile(lock, "utf8");
    expect(content).toBe(`${process.pid}\n`);
    await handle.release();
  });

  it("refuses a concurrent claim when the PID is live", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    const a = await claimLock(lock);
    await expect(claimLock(lock)).rejects.toBeInstanceOf(LockHeldError);
    await a.release();
  });

  it("LockHeldError carries the holding PID and the lock path", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    const a = await claimLock(lock);
    try {
      await claimLock(lock);
      throw new Error("expected claimLock to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      const lhe = err as LockHeldError;
      expect(lhe.holdingPid).toBe(process.pid);
      expect(lhe.lockPath).toBe(lock);
    } finally {
      await a.release();
    }
  });

  it("reclaims a lock whose PID does not exist", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    // Use 2^31 - 2 as a "definitely-dead" PID (way beyond any normal range).
    await writeFile(lock, "2147483646\n");
    const handle = await claimLock(lock);
    const content = await readFile(lock, "utf8");
    expect(content).toBe(`${process.pid}\n`);
    await handle.release();
  });

  it("reclaims a lock with unparseable contents", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    await writeFile(lock, "garbage garbage\n");
    const handle = await claimLock(lock);
    const content = await readFile(lock, "utf8");
    expect(content).toBe(`${process.pid}\n`);
    await handle.release();
  });

  it("release deletes the lockfile", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    const handle = await claimLock(lock);
    await handle.release();
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("release after external deletion is a no-op", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    const handle = await claimLock(lock);
    const { unlink } = await import("node:fs/promises");
    await unlink(lock);
    // Should not throw.
    await handle.release();
  });

  it("creates the locks directory if it doesn't exist", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "nested", "deep", "foo.lock");
    const handle = await claimLock(lock);
    const content = await readFile(lock, "utf8");
    expect(content).toBe(`${process.pid}\n`);
    await handle.release();
  });
});

describe("probeLockLiveness", () => {
  it("reports orphaned when the lockfile is missing", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "missing.lock");
    const result = await probeLockLiveness(lock);
    expect(result).toEqual({ orphaned: true });
  });

  it("reports running when the lockfile names a live PID", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    await writeFile(lock, `${process.pid}\n`, "utf8");
    const result = await probeLockLiveness(lock);
    expect(result).toEqual({ running: true, pid: process.pid });
  });

  it("reports orphaned when the lockfile names a dead PID", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    // 2^31 - 2 = a PID well beyond any plausible running process.
    await writeFile(lock, "2147483646\n", "utf8");
    const result = await probeLockLiveness(lock);
    expect(result).toEqual({ orphaned: true });
  });

  it("throws on an unparseable PID", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    await writeFile(lock, "garbage garbage\n", "utf8");
    await expect(probeLockLiveness(lock)).rejects.toThrow(/unparseable PID/);
  });

  it("reports running when EPERM (mocked liveness check)", async () => {
    const dir = await makeDir();
    const lock = path.join(dir, "foo.lock");
    await writeFile(lock, "424242\n", "utf8");
    // The injected `isLive` mirrors the real `isLivePid`'s EPERM branch:
    // EPERM means we cannot disprove liveness, so treat as live.
    const result = await probeLockLiveness(lock, () => true);
    expect(result).toEqual({ running: true, pid: 424242 });
  });
});
