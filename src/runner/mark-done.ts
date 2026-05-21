import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface MarkBriefDoneInput {
  change: string;
  runCwd: string;
}

export interface MarkBriefDoneResult {
  moved: boolean;
  warning?: string;
}

interface ChildResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runGit(cwd: string, args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => outChunks.push(b));
    child.stderr.on("data", (b: Buffer) => errChunks.push(b));
    child.on("error", (err) => {
      resolve({ stdout: "", stderr: (err as Error).message, exitCode: null });
    });
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

/**
 * Move a brief from `inputs/<change>.md` to `inputs/done/<change>.md` and
 * commit the move inside `runCwd`. Idempotent: if the source is already
 * gone and the destination exists, returns `{ moved: false }` without a
 * warning. Failures of `git mv` or `git commit` produce a warning string
 * but do not throw — callers SHALL still record the run as `succeeded`.
 */
export async function markBriefDone(input: MarkBriefDoneInput): Promise<MarkBriefDoneResult> {
  const sourceRel = path.posix.join("inputs", `${input.change}.md`);
  const destRel = path.posix.join("inputs", "done", `${input.change}.md`);
  const sourceAbs = path.join(input.runCwd, "inputs", `${input.change}.md`);
  const destAbs = path.join(input.runCwd, "inputs", "done", `${input.change}.md`);

  const sourceExists = existsSync(sourceAbs);
  const destExists = existsSync(destAbs);

  if (!sourceExists && destExists) {
    return { moved: false };
  }
  if (!sourceExists && !destExists) {
    return {
      moved: false,
      warning: `mark-done: brief \`${input.change}\` not found at ${sourceAbs}`,
    };
  }

  try {
    mkdirSync(path.join(input.runCwd, "inputs", "done"), { recursive: true });
  } catch (err) {
    return {
      moved: false,
      warning: `mark-done: could not create inputs/done/ in ${input.runCwd}: ${(err as Error).message}`,
    };
  }

  const mv = await runGit(input.runCwd, ["mv", sourceRel, destRel]);
  if (mv.exitCode !== 0) {
    return {
      moved: false,
      warning: `mark-done: \`git mv ${sourceRel} ${destRel}\` failed for \`${input.change}\`: ${mv.stderr.trim() || `exit ${mv.exitCode}`}`,
    };
  }
  const commit = await runGit(input.runCwd, ["commit", "-m", `Mark ${input.change} done`]);
  if (commit.exitCode !== 0) {
    return {
      moved: true,
      warning: `mark-done: \`git commit\` failed for \`${input.change}\`: ${commit.stderr.trim() || `exit ${commit.exitCode}`}`,
    };
  }
  return { moved: true };
}
