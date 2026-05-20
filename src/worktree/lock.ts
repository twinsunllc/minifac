import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class LockHeldError extends Error {
  constructor(
    message: string,
    readonly holdingPid: number,
    readonly lockPath: string,
  ) {
    super(message);
    this.name = "LockHeldError";
  }
}

export interface LockHandle {
  release(): Promise<void>;
}

function isLivePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // signal 0 checks for the existence of the process without sending one.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but we don't own it. Treat as live
    // (conservative — see design.md).
    if (code === "EPERM") return true;
    return false;
  }
}

async function exclusiveCreate(lockPath: string, pid: number): Promise<boolean> {
  try {
    const fh = await open(lockPath, "wx");
    try {
      await fh.writeFile(`${pid}\n`, "utf8");
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  }
}

async function reclaimAtomic(lockPath: string, pid: number): Promise<void> {
  const tmp = `${lockPath}.${pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, `${pid}\n`, "utf8");
  await rename(tmp, lockPath);
}

/**
 * Claim a PID-bearing lockfile at `lockPath`. Throws `LockHeldError` if a live
 * process already holds it. Reclaims atomically when the existing PID is
 * stale (dead or unparseable). On success returns a handle whose `release()`
 * best-effort-deletes the file (ENOENT is not an error).
 */
export async function claimLock(lockPath: string): Promise<LockHandle> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const pid = process.pid;

  if (await exclusiveCreate(lockPath, pid)) {
    return makeHandle(lockPath);
  }

  // EEXIST → inspect.
  let existing: string;
  try {
    existing = await readFile(lockPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Raced — the file disappeared between create and read. Retry.
      if (await exclusiveCreate(lockPath, pid)) return makeHandle(lockPath);
      throw new LockHeldError(`Lock at ${lockPath} is contended`, 0, lockPath);
    }
    throw err;
  }
  const trimmed = existing.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Unparseable → stale, reclaim.
    await reclaimAtomic(lockPath, pid);
    return makeHandle(lockPath);
  }

  if (!isLivePid(parsed)) {
    await reclaimAtomic(lockPath, pid);
    return makeHandle(lockPath);
  }

  throw new LockHeldError(`Lock is held by PID ${parsed} at ${lockPath}`, parsed, lockPath);
}

function makeHandle(lockPath: string): LockHandle {
  return {
    async release(): Promise<void> {
      try {
        await unlink(lockPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        throw err;
      }
    },
  };
}
