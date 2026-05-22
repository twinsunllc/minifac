// Check-merge executor.
//
// Performs a read-only mergeability probe of a worktree's HEAD against a
// configured base branch. Emits a final `status: succeeded` event when the
// merge would auto-resolve cleanly (under the chosen mode), `failed`
// otherwise. The worktree state is byte-for-byte unchanged across every
// path — see the post-probe assertion below.
//
// Wire details and rationale live in
// `openspec/changes/check-merge-step/design.md` and the
// `check-merge-step` capability spec.

import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { NodeEvent, NodeExecutor, ResolvedNode, RunContext } from "./types.js";

const WithSchema = z
  .object({
    base: z.string().optional(),
    mode: z.enum(["any-merge", "fast-forward"]).optional(),
  })
  .strict();

export type CheckMergeWith = z.infer<typeof WithSchema>;

export interface GitInvocation {
  args: readonly string[];
  cwd: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (invocation: GitInvocation) => Promise<GitResult>;

export interface CheckMergeExecutorOptions {
  /** Injectable git runner for testing. Defaults to spawning `git`. */
  gitRunner?: GitRunner;
}

interface WorktreeSnapshot {
  head: string;
  porcelain: string;
  untracked: string;
  mergeFiles: Record<string, string | null>;
}

const MERGE_FILES = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"] as const;

async function defaultGitRunner(inv: GitInvocation): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    const child = nodeSpawn("git", inv.args as string[], { cwd: inv.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function snapshotWorktree(cwd: string, runner: GitRunner): Promise<WorktreeSnapshot> {
  const head = await runner({ args: ["rev-parse", "HEAD"], cwd });
  const status = await runner({ args: ["status", "--porcelain"], cwd });
  const untracked = await runner({
    args: ["ls-files", "--others", "--exclude-standard"],
    cwd,
  });
  const mergeFiles: Record<string, string | null> = {};
  for (const name of MERGE_FILES) {
    const fp = path.join(cwd, ".git", name);
    try {
      const buf = await readFile(fp);
      mergeFiles[name] = createHash("sha256").update(buf).digest("hex");
    } catch {
      mergeFiles[name] = null;
    }
  }
  return {
    head: head.stdout.trim(),
    porcelain: status.stdout,
    untracked: untracked.stdout,
    mergeFiles,
  };
}

function assertSnapshotsEqual(before: WorktreeSnapshot, after: WorktreeSnapshot): void {
  if (before.head !== after.head) {
    throw new Error(
      `check-merge invariant violation: HEAD changed (before=${before.head} after=${after.head})`,
    );
  }
  if (before.porcelain !== after.porcelain) {
    throw new Error("check-merge invariant violation: git status --porcelain differs after probe");
  }
  if (before.untracked !== after.untracked) {
    throw new Error("check-merge invariant violation: untracked file set differs after probe");
  }
  for (const name of MERGE_FILES) {
    const b = before.mergeFiles[name] ?? null;
    const a = after.mergeFiles[name] ?? null;
    if (b !== a) {
      throw new Error(
        `check-merge invariant violation: .git/${name} differs after probe (before=${b ?? "absent"} after=${a ?? "absent"})`,
      );
    }
  }
}

async function refExists(runner: GitRunner, cwd: string, ref: string): Promise<boolean> {
  const r = await runner({ args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd });
  return r.code === 0;
}

export class CheckMergeExecutor implements NodeExecutor {
  readonly type = "check-merge";

  private readonly gitRunner: GitRunner;

  constructor(options: CheckMergeExecutorOptions = {}) {
    this.gitRunner = options.gitRunner ?? defaultGitRunner;
  }

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    yield { kind: "status", status: "started" };

    const raw = (node.with ?? {}) as Record<string, unknown>;
    const allowedKeys = new Set(["base", "mode"]);
    for (const k of Object.keys(raw)) {
      if (!allowedKeys.has(k)) {
        yield {
          kind: "status",
          status: "failed",
          meta: {
            reason: "invalid_with",
            key: k,
            message: `Unknown \`with:\` key \`${k}\` for executor \`check-merge\`. Accepted keys: base, mode.`,
          },
        };
        return;
      }
    }

    const parsed = WithSchema.safeParse(raw);
    if (!parsed.success) {
      // Most likely cause: mode is not one of the literals.
      const issue = parsed.error.issues[0];
      const offendingPath = issue?.path.join(".") ?? "";
      let message = `Invalid \`with:\` for executor \`check-merge\`: ${issue?.message ?? "validation error"}`;
      if (offendingPath === "mode") {
        const got = (raw as { mode?: unknown }).mode;
        message = `Unknown \`mode\` value \`${String(got)}\` for executor \`check-merge\`. Supported values: "any-merge", "fast-forward".`;
      }
      yield {
        kind: "status",
        status: "failed",
        meta: { reason: "invalid_with", message },
      };
      return;
    }

    const mode = parsed.data.mode ?? "any-merge";
    const base = parsed.data.base ?? "";
    if (base.length === 0) {
      yield {
        kind: "status",
        status: "failed",
        meta: {
          reason: "missing_base",
          message:
            "Resolved `with.base` is empty; declare `with: { base: <branch> }` explicitly or run from a worktree whose `run.base_branch` is set.",
        },
      };
      return;
    }

    const cwd = ctx.cwd;

    // Validate base exists before probing.
    if (!(await refExists(this.gitRunner, cwd, base))) {
      yield {
        kind: "status",
        status: "failed",
        meta: {
          reason: "missing_base_ref",
          base,
          message: `Base ref \`${base}\` does not exist in the worktree at ${cwd}.`,
        },
      };
      return;
    }

    const before = await snapshotWorktree(cwd, this.gitRunner);

    let finalEvent: NodeEvent;
    try {
      finalEvent = await this.probe(cwd, base, mode);
    } finally {
      const after = await snapshotWorktree(cwd, this.gitRunner);
      // Programmer-error assertion: violation crashes loud.
      assertSnapshotsEqual(before, after);
    }

    yield finalEvent;
  }

  private async probe(
    cwd: string,
    base: string,
    mode: "any-merge" | "fast-forward",
  ): Promise<NodeEvent> {
    if (mode === "fast-forward") {
      const ancestor = await this.gitRunner({
        args: ["merge-base", "--is-ancestor", base, "HEAD"],
        cwd,
      });
      if (ancestor.code !== 0) {
        return {
          kind: "status",
          status: "failed",
          meta: {
            reason: "fast_forward_required",
            base,
            mode,
            message: `merge commit required under fast-forward mode (base \`${base}\` is not an ancestor of HEAD).`,
          },
        };
      }
    }

    const mergeTree = await this.gitRunner({
      args: ["merge-tree", "--write-tree", "--name-only", base, "HEAD"],
      cwd,
    });
    if (mergeTree.code === 0) {
      return { kind: "status", status: "succeeded", meta: { mode, base } };
    }
    if (mergeTree.code === 1) {
      const lines = mergeTree.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      // First line of stdout is the merged tree OID when --write-tree is
      // honored; conflicting paths follow. Strip the leading SHA-like
      // line for the human message.
      const conflictPaths = lines.filter((line) => !/^[0-9a-f]{40,}$/i.test(line));
      const count = conflictPaths.length;
      return {
        kind: "status",
        status: "failed",
        meta: {
          reason: "merge_conflict",
          base,
          mode,
          conflictPaths,
          message:
            count > 0
              ? `merge would conflict at ${count} path(s): ${conflictPaths.join(", ")}`
              : "merge would conflict (no path list reported)",
        },
      };
    }
    if (mergeTree.code === 128) {
      return await this.runFallback(cwd, base, mode);
    }
    return {
      kind: "status",
      status: "failed",
      meta: {
        reason: "git_error",
        base,
        mode,
        exitCode: mergeTree.code,
        message: `git merge-tree exited ${mergeTree.code}: ${mergeTree.stderr.trim() || "(no stderr)"}`,
      },
    };
  }

  private async runFallback(
    cwd: string,
    base: string,
    mode: "any-merge" | "fast-forward",
  ): Promise<NodeEvent> {
    let mergeResult: GitResult | null = null;
    try {
      mergeResult = await this.gitRunner({
        args: ["merge", "--no-commit", "--no-ff", base],
        cwd,
      });
    } finally {
      // Always attempt abort, even on success-path exit so the worktree-clean
      // invariant holds in both branches.
      try {
        await this.gitRunner({ args: ["merge", "--abort"], cwd });
      } catch {
        // best-effort; the snapshot assertion will catch any state leak.
      }
    }
    if (!mergeResult) {
      return {
        kind: "status",
        status: "failed",
        meta: {
          reason: "git_error",
          base,
          mode,
          message: "git merge fallback did not return a result",
        },
      };
    }
    if (mergeResult.code === 0) {
      return {
        kind: "status",
        status: "succeeded",
        meta: { mode, base, fallback: true },
      };
    }
    return {
      kind: "status",
      status: "failed",
      meta: {
        reason: "merge_conflict",
        base,
        mode,
        fallback: true,
        message: `merge would conflict (fallback path; git merge exit ${mergeResult.code})`,
      },
    };
  }
}
