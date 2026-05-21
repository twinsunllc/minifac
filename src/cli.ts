#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { BriefLoadError } from "./brief/loader.js";
import { briefCommandAction } from "./cli/brief.js";
import { initAction } from "./cli/init.js";
import { runMerge } from "./cli/merge.js";
import { RunArgResolutionError, resolveRunArg } from "./cli/resolve.js";
import { listAction as runsListAction, showAction as runsShowAction } from "./cli/runs.js";
import { ClaudeExecutor } from "./executor/claude.js";
import { ExecutorRegistry } from "./executor/registry.js";
import { FactoryLoadError, loadFactory } from "./factory/loader.js";
import { runFactory } from "./runner/run.js";
import { type DaemonHandle, startDaemon } from "./serve/server.js";
import { openDefaultRunStore } from "./storage/open.js";
import type { RunStore } from "./storage/run-store.js";
import { WorktreeConfigError, loadWorktreeConfig } from "./worktree/config.js";
import { GitError, gitRevParseHead, gitWorktreeAdd } from "./worktree/git.js";
import { appendFailedRun } from "./worktree/journal.js";
import { type LockHandle, LockHeldError, claimLock } from "./worktree/lock.js";
import {
  computeRepoHash,
  lockPathForKey,
  runBranchName,
  runSlugFromId,
  runWorktreeDirName,
  runWorktreePathForDir,
  worktreeKeyForBrief,
  worktreeKeyForFactory,
} from "./worktree/paths.js";
import { type PruneOptions, parseOlderThan, pruneWorktrees } from "./worktree/prune.js";

export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  buildRegistry?: () => ExecutorRegistry;
  startDaemon?: typeof startDaemon;
  serveReturnImmediately?: boolean;
  runCwd?: string;
  /** Optional override of the run-history store opener (tests). */
  openRunStore?: (cwd: string) => Promise<RunStore>;
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
      let store: RunStore | undefined;

      try {
        const resolved = await resolveRunArg(arg, cwd);
        const loaded = await loadFactory(resolved.factoryPath, cwd);
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
        // Generate the run id up front so we can derive a per-run slug
        // before the runner row exists.
        const runId = randomUUID();
        const slug = runSlugFromId(runId);
        const segment = brief ? brief.frontmatter.change : factoryName;
        const branchName = runBranchName(segment, slug);
        const worktreeDirName = runWorktreeDirName(segment, slug);
        // Lockfile key keeps the old shape — see docs/decisions/0019.
        let key: string;
        if (brief) {
          key = worktreeKeyForBrief(repoHash, brief.frontmatter.change);
        } else {
          const timestamp = Date.now();
          key = worktreeKeyForFactory(repoHash, factoryName, timestamp);
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
              `Another minifac run is in progress for key \`${key}\` (PID ${err.holdingPid}, lockfile ${err.lockPath}). ` +
                `The lockfile serializes same-change invocations even though per-run branches no longer collide; ` +
                `\`--force\` does not override it. ` +
                `For parallel A/B runs of the same change, see the future \`--factory\` flag described in ` +
                `docs/decisions/0020-Factory-Override-At-Invocation.md.\n`,
            );
            exitCode = 1;
            return;
          }
          throw err;
        }

        if (inPlace) {
          runCwd = cwd;
        } else {
          const wtPath = runWorktreePathForDir(config, worktreeDirName);
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
        try {
          store = await (io.openRunStore ?? openDefaultRunStore)(cwd);
        } catch (err) {
          io.stderr.write(`Warning: could not open run history store: ${(err as Error).message}\n`);
          store = undefined;
        }
        const result = await runFactory(loaded, {
          registry,
          brief,
          runCwd,
          store,
          runId,
          branchName: inPlace ? undefined : branchName,
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
        if (store) {
          try {
            await store.close();
          } catch {
            // best effort
          }
        }
      }
    });

  program
    .command("init")
    .description(
      "Bootstrap minifac's directory layout in cwd: inputs/, .minifac/, and .minifac/factories/.",
    )
    .option("--with-sdd", "Also write a starter .minifac/factories/sdd.yaml extending minifac:sdd")
    .action(async (opts: { withSdd?: boolean }) => {
      const cwd = io.runCwd ?? process.cwd();
      exitCode = await initAction({
        cwd,
        withSdd: opts.withSdd === true,
        io: { stdout: io.stdout, stderr: io.stderr },
      });
    });

  program
    .command("brief")
    .description("Author a brief at inputs/<name>.md via one-question-at-a-time prompts.")
    .argument("<name>", "change name (used as default for the `change` frontmatter field)")
    .option("--from <file>", "Non-interactive: read answers from a YAML or JSON file")
    .option("--out <path>", "Override the default output path (inputs/<name>.md)")
    .option("--force", "Overwrite an existing brief file")
    .action(async (name: string, opts: { from?: string; out?: string; force?: boolean }) => {
      const cwd = io.runCwd ?? process.cwd();
      const stdin = io.stdin ?? process.stdin;
      const code = await briefCommandAction({
        name,
        from: opts.from,
        out: opts.out,
        force: opts.force,
        cwd,
        io: { stdin, stdout: io.stdout, stderr: io.stderr },
      });
      exitCode = code;
    });

  program
    .command("merge")
    .description(
      "Merge the branch produced by a run into the default branch. Argument is a run-id prefix or a change name.",
    )
    .argument("<arg>", "run-id prefix (≥6 hex chars) or change name")
    .option("--ff-only", "Refuse the merge-commit fallback if fast-forward fails")
    .option("--pick", "When multiple runs match a change, prompt to pick one")
    .option("--force", "Allow merging a non-succeeded run")
    .action(async (arg: string, opts: { ffOnly?: boolean; pick?: boolean; force?: boolean }) => {
      const cwd = io.runCwd ?? process.cwd();
      let store: RunStore | undefined;
      try {
        store = await (io.openRunStore ?? openDefaultRunStore)(cwd);
      } catch (err) {
        io.stderr.write(`Could not open run history store: ${(err as Error).message}\n`);
        exitCode = 1;
        return;
      }
      try {
        exitCode = await runMerge({
          arg,
          ffOnly: opts.ffOnly === true,
          pick: opts.pick === true,
          force: opts.force === true,
          store,
          cwd,
          stdin: io.stdin ?? process.stdin,
          stdout: io.stdout,
          stderr: io.stderr,
        });
      } finally {
        try {
          await store.close();
        } catch {
          // best effort
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

          // Open the runs DB so prune can look up `branchName` for each
          // pruned worktree. Best-effort — the inference fallback covers
          // the case where the store can't open.
          let pruneStore: RunStore | undefined;
          try {
            pruneStore = await (io.openRunStore ?? openDefaultRunStore)(cwd);
          } catch {
            pruneStore = undefined;
          }
          let counts: Awaited<ReturnType<typeof pruneWorktrees>>;
          try {
            counts = await pruneWorktrees({
              config,
              callerRepoCwd: cwd,
              options,
              ...(pruneStore !== undefined ? { store: pruneStore } : {}),
              stderr: io.stderr,
            });
          } finally {
            if (pruneStore) {
              try {
                await pruneStore.close();
              } catch {
                // best effort
              }
            }
          }

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

  const runsCmd = program
    .command("runs")
    .description("List persisted runs from the local runs.db.")
    .option("--factory <name>", "Filter by factory name")
    .option("--change <name>", "Filter by brief change name")
    .option("--status <s>", "Filter by status (running | succeeded | failed)")
    .option("--limit <n>", "Cap the number of runs returned (default 20)")
    .option("--json", "Emit a JSON array instead of a table")
    .action(
      async (opts: {
        factory?: string;
        change?: string;
        status?: string;
        limit?: string;
        json?: boolean;
      }) => {
        const cwd = io.runCwd ?? process.cwd();
        let store: RunStore | undefined;
        try {
          store = await (io.openRunStore ?? openDefaultRunStore)(cwd);
        } catch (err) {
          io.stderr.write(`Could not open run history store: ${(err as Error).message}\n`);
          exitCode = 1;
          return;
        }
        try {
          exitCode = await runsListAction({
            ...(opts.factory !== undefined ? { factory: opts.factory } : {}),
            ...(opts.change !== undefined ? { change: opts.change } : {}),
            ...(opts.status !== undefined ? { status: opts.status } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            ...(opts.json !== undefined ? { json: opts.json } : {}),
            store,
            io: { stdout: io.stdout, stderr: io.stderr },
          });
        } finally {
          await store.close();
        }
      },
    );

  runsCmd
    .command("show <id>")
    .description("Print the persisted event log for one run (id or unambiguous prefix).")
    .option("--follow", "Tail an active run via short-interval polling")
    .option("--json", "Emit NDJSON, one event per line")
    .action(async (id: string, opts: { follow?: boolean; json?: boolean }) => {
      const cwd = io.runCwd ?? process.cwd();
      let store: RunStore | undefined;
      try {
        store = await (io.openRunStore ?? openDefaultRunStore)(cwd);
      } catch (err) {
        io.stderr.write(`Could not open run history store: ${(err as Error).message}\n`);
        exitCode = 1;
        return;
      }
      try {
        exitCode = await runsShowAction({
          idOrPrefix: id,
          ...(opts.follow !== undefined ? { follow: opts.follow } : {}),
          ...(opts.json !== undefined ? { json: opts.json } : {}),
          store,
          io: { stdout: io.stdout, stderr: io.stderr },
        });
      } finally {
        await store.close();
      }
    });

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
