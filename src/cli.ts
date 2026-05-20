#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { BriefLoadError } from "./brief/loader.js";
import { RunArgResolutionError, resolveRunArg } from "./cli/resolve.js";
import { ClaudeExecutor } from "./executor/claude.js";
import { ExecutorRegistry } from "./executor/registry.js";
import { FactoryLoadError, loadFactory } from "./factory/loader.js";
import { runFactory } from "./runner/run.js";
import { type DaemonHandle, startDaemon } from "./serve/server.js";
import { WorktreeConfigError, loadWorktreeConfig } from "./worktree/config.js";
import { GitError, gitRevParseHead, gitWorktreeAdd } from "./worktree/git.js";
import { appendFailedRun } from "./worktree/journal.js";
import { type LockHandle, LockHeldError, claimLock } from "./worktree/lock.js";
import {
  computeRepoHash,
  lockPathForKey,
  worktreeKeyForBrief,
  worktreeKeyForFactory,
  worktreePathForKey,
} from "./worktree/paths.js";
import { type PruneOptions, parseOlderThan, pruneWorktrees } from "./worktree/prune.js";

export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  buildRegistry?: () => ExecutorRegistry;
  startDaemon?: typeof startDaemon;
  serveReturnImmediately?: boolean;
  runCwd?: string;
}

function defaultRegistry(): ExecutorRegistry {
  const reg = new ExecutorRegistry();
  reg.register(new ClaudeExecutor());
  return reg;
}

function describeError(err: unknown, io: CliIO): void {
  if (err instanceof FactoryLoadError) {
    const loc = err.location
      ? ` (line ${err.location.line}${err.location.col ? `, col ${err.location.col}` : ""})`
      : "";
    io.stderr.write(`Error loading factory ${err.sourcePath}${loc}: ${err.message}\n`);
  } else if (err instanceof BriefLoadError) {
    const loc = err.location
      ? ` (line ${err.location.line}${err.location.col ? `, col ${err.location.col}` : ""})`
      : "";
    io.stderr.write(`Error loading brief ${err.sourcePath}${loc}: ${err.message}\n`);
  } else if (err instanceof RunArgResolutionError) {
    io.stderr.write(`${err.message}\n`);
  } else if (err instanceof WorktreeConfigError) {
    const loc = err.location
      ? ` (line ${err.location.line}${err.location.col ? `, col ${err.location.col}` : ""})`
      : "";
    io.stderr.write(`Error loading minifac config ${err.sourcePath}${loc}: ${err.message}\n`);
  } else if (err instanceof GitError) {
    io.stderr.write(`Error: ${err.message}\n`);
  } else {
    io.stderr.write(`Error: ${(err as Error).message}\n`);
  }
}

export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const program = new Command();
  program
    .name("minifac")
    .description("Run a minifac factory.")
    .version("0.0.0")
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.stdout.write(str),
      writeErr: (str) => io.stderr.write(str),
    });

  let exitCode = 0;

  program
    .command("run")
    .description("Run a factory by brief path, brief name, or factory name.")
    .argument("<thing>", "brief path, brief name, or factory name")
    .option("--in-place", "Skip worktree creation; run the factory in the current cwd")
    .action(async (arg: string, opts: { inPlace?: boolean }) => {
      const cwd = io.runCwd ?? process.cwd();
      let lock: LockHandle | undefined;
      let runCwd: string | undefined;

      try {
        const resolved = await resolveRunArg(arg, cwd);
        const loaded = await loadFactory(resolved.factoryPath);
        const factoryName = loaded.factory.name;
        const briefMode = loaded.factory.brief;
        const brief = resolved.kind === "brief" ? resolved.brief : undefined;

        if (resolved.kind === "brief" && briefMode === "none") {
          io.stderr.write(
            `Factory \`${factoryName}\` declares \`brief: none\` but was invoked with a brief at ${resolved.brief.sourcePath}.\n`,
          );
          exitCode = 1;
          return;
        }
        if (resolved.kind === "factory" && briefMode === "required") {
          io.stderr.write(
            `Factory \`${factoryName}\` requires a brief; invoke as \`minifac run <brief-name>\` with a brief at inputs/<name>.md.\n`,
          );
          exitCode = 1;
          return;
        }

        const briefMode_inPlace =
          brief !== undefined && (brief.frontmatter as { mode?: string }).mode === "in-place";
        const inPlace = opts.inPlace === true || briefMode_inPlace;

        const config = await loadWorktreeConfig(cwd);
        const repoHash = await computeRepoHash(cwd);
        let key: string;
        let branchName: string;
        if (brief) {
          key = worktreeKeyForBrief(repoHash, brief.frontmatter.change);
          branchName = brief.frontmatter.change;
        } else {
          const timestamp = Date.now();
          key = worktreeKeyForFactory(repoHash, factoryName, timestamp);
          branchName = `${factoryName}-${timestamp.toString(36)}`;
        }

        // Lazy-prune (worktree mode only). Best-effort; failures don't
        // stop the run.
        if (!inPlace) {
          try {
            await pruneWorktrees({
              config,
              callerRepoCwd: cwd,
              options: { lazy: true },
            });
          } catch {
            // swallow per spec — explicit `minifac prune` carries the cost.
          }
        }

        // Claim lock BEFORE worktree creation.
        const lockPath = lockPathForKey(config, key);
        try {
          lock = await claimLock(lockPath);
        } catch (err) {
          if (err instanceof LockHeldError) {
            io.stderr.write(
              `Another minifac run is in progress for key \`${key}\` (PID ${err.holdingPid}, lockfile ${err.lockPath}).\n`,
            );
            exitCode = 1;
            return;
          }
          throw err;
        }

        if (inPlace) {
          runCwd = cwd;
        } else {
          const wtPath = worktreePathForKey(config, key);
          let baseRev: string;
          if (brief?.frontmatter.base_branch && brief.frontmatter.base_branch.length > 0) {
            baseRev = brief.frontmatter.base_branch;
          } else {
            try {
              baseRev = await gitRevParseHead(cwd);
            } catch (err) {
              io.stderr.write(`Could not resolve HEAD in ${cwd}: ${(err as Error).message}\n`);
              exitCode = 1;
              return;
            }
          }
          try {
            await mkdir(config.worktreesDir, { recursive: true });
            await gitWorktreeAdd(cwd, wtPath, branchName, baseRev);
          } catch (err) {
            io.stderr.write(`Failed to create worktree at ${wtPath}: ${(err as Error).message}\n`);
            exitCode = 1;
            return;
          }
          runCwd = wtPath;
        }

        const registry = (io.buildRegistry ?? defaultRegistry)();
        const result = await runFactory(loaded, {
          registry,
          brief,
          runCwd,
          onEvent: (entry) => {
            const prefix = `[${entry.nodeId}]`;
            const e = entry.event;
            if (e.kind === "stdout") {
              io.stdout.write(`${prefix} ${e.line}\n`);
            } else if (e.kind === "stderr") {
              io.stderr.write(`${prefix} ${e.line}\n`);
            } else {
              io.stderr.write(`[status] ${entry.nodeId} iter=${entry.iteration}: ${e.status}\n`);
            }
          },
        });

        let runStatus: "succeeded" | "failed" = "succeeded";
        if (result.status === "succeeded") {
          exitCode = 0;
        } else {
          runStatus = "failed";
          switch (result.reason) {
            case "budget_exhausted":
              exitCode = 3;
              io.stderr.write(
                `Run failed: budget exhausted${result.proximateNodeId ? ` at node "${result.proximateNodeId}"` : ""}\n`,
              );
              break;
            case "node_failed":
            case "graph_drained":
            case "unknown_executor":
              exitCode = 2;
              io.stderr.write(
                `Run failed: ${result.reason}${result.proximateNodeId ? ` at node "${result.proximateNodeId}"` : ""}\n`,
              );
              break;
            default:
              exitCode = 2;
              break;
          }
          try {
            await appendFailedRun({
              worktreeDir: runCwd,
              status: "failed",
              endedAt: new Date().toISOString(),
              reason: result.reason,
            });
          } catch {
            // journal errors are non-fatal
          }
        }

        // Final stderr summary line (always emit, success or failure).
        io.stderr.write(`[run] ${runStatus} cwd=${runCwd}\n`);
      } catch (err) {
        describeError(err, io);
        exitCode = 1;
      } finally {
        if (lock) {
          try {
            await lock.release();
          } catch {
            // best effort
          }
        }
      }
    });

  program
    .command("prune")
    .description(
      "Prune worktrees per the hybrid policy. See docs/decisions/0010-Worktree-Cleanup-Hybrid.md.",
    )
    .option(
      "--all",
      "Remove fresh, merged-old, and unmerged-old worktrees (does not touch failed by default)",
    )
    .option(
      "--merged",
      "Remove worktrees whose branch has merged to the default branch (default policy)",
    )
    .option(
      "--older-than <duration>",
      "Override the age cutoff. Format: <int><m|h|d>, e.g. 7d, 12h, 30m",
    )
    .option("--failed", "Also remove worktrees from failed runs")
    .action(
      async (opts: {
        all?: boolean;
        merged?: boolean;
        olderThan?: string;
        failed?: boolean;
      }) => {
        const cwd = io.runCwd ?? process.cwd();
        try {
          let olderThan: { value: number; unit: "m" | "h" | "d" } | undefined;
          if (opts.olderThan) {
            try {
              olderThan = parseOlderThan(opts.olderThan);
            } catch (err) {
              io.stderr.write(`${(err as Error).message}\n`);
              exitCode = 1;
              return;
            }
          }
          const config = await loadWorktreeConfig(cwd);
          const options: PruneOptions = {};
          if (opts.all) options.all = true;
          if (opts.merged) options.merged = true;
          if (opts.failed) options.failed = true;
          if (olderThan) options.olderThan = olderThan;

          const counts = await pruneWorktrees({
            config,
            callerRepoCwd: cwd,
            options,
          });

          io.stdout.write(
            `Pruned: merged-old=${counts.removed["merged-old"]}, unmerged-old=${counts.removed["unmerged-old"]}, fresh=${counts.removed.fresh}, failed=${counts.removed.failed}\n`,
          );
          for (const e of counts.errors) {
            io.stderr.write(`Failed to remove ${e.dir}: ${e.message}\n`);
          }
          exitCode = 0;
        } catch (err) {
          describeError(err, io);
          exitCode = 1;
        }
      },
    );

  program
    .command("serve")
    .description("Start the local minifac daemon (web viewer + HTTP API).")
    .argument("[dir]", "directory to watch for factory YAML files", ".")
    .option("--port <number>", "TCP port to bind", "4280")
    .option("--host <string>", "loopback host to bind", "127.0.0.1")
    .action(async (dir: string, opts: { port: string; host: string }) => {
      const port = Number.parseInt(opts.port, 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        io.stderr.write(`Invalid --port: ${opts.port}\n`);
        exitCode = 1;
        return;
      }
      const start = io.startDaemon ?? startDaemon;
      let handle: DaemonHandle;
      try {
        handle = await start({ dir, host: opts.host, port });
      } catch (err) {
        io.stderr.write(`Failed to start daemon: ${(err as Error).message}\n`);
        exitCode = 1;
        return;
      }
      io.stderr.write(
        `minifac serve listening on http://${handle.host}:${handle.port} (watching ${dir})\n`,
      );
      if (io.serveReturnImmediately) {
        await handle.close();
        return;
      }
      await new Promise<void>((resolve) => {
        const stop = (sig: NodeJS.Signals) => {
          io.stderr.write(`received ${sig}, shutting down\n`);
          handle.close().finally(() => resolve());
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      exitCode = 0;
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    const ce = err as { code?: string; exitCode?: number; message?: string };
    if (
      ce.code === "commander.helpDisplayed" ||
      ce.code === "commander.help" ||
      ce.code === "commander.version"
    ) {
      return 0;
    }
    if (ce.message) io.stderr.write(`${ce.message}\n`);
    return typeof ce.exitCode === "number" && ce.exitCode !== 0 ? 1 : 1;
  }

  return exitCode;
}

const isMain = (() => {
  try {
    const here = fileURLToPath(import.meta.url);
    return here === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      process.stderr.write(`Unexpected error: ${(err as Error).stack ?? err}\n`);
      process.exit(1);
    },
  );
}
