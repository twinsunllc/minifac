#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { BriefLoadError } from "./brief/loader.js";
import { RunArgResolutionError, resolveRunArg } from "./cli/resolve.js";
import { ClaudeExecutor } from "./executor/claude.js";
import { ExecutorRegistry } from "./executor/registry.js";
import { FactoryLoadError, loadFactory } from "./factory/loader.js";
import { runFactory } from "./runner/run.js";
import { type DaemonHandle, startDaemon } from "./serve/server.js";

export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /**
   * Optional injectable factory for the executor registry. Useful for tests
   * that don't want the real Claude executor wired up.
   */
  buildRegistry?: () => ExecutorRegistry;
  /**
   * Optional override for the daemon-start function (tests). When set, the
   * `serve` subcommand calls this instead of the real `startDaemon`.
   */
  startDaemon?: typeof startDaemon;
  /**
   * When true, the `serve` subcommand returns immediately after the daemon
   * is listening instead of waiting for SIGINT/SIGTERM. Tests use this.
   */
  serveReturnImmediately?: boolean;
  /**
   * Optional override for the cwd the `run` subcommand resolves arguments
   * against. Defaults to `process.cwd()`. Tests use this so the
   * lookup-precedence rules can be exercised against a fixture directory.
   */
  runCwd?: string;
}

function defaultRegistry(): ExecutorRegistry {
  const reg = new ExecutorRegistry();
  reg.register(new ClaudeExecutor());
  return reg;
}

/**
 * Internal entry — returns the exit code instead of calling process.exit so
 * it's testable.
 */
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
    .action(async (arg: string) => {
      const cwd = io.runCwd ?? process.cwd();
      try {
        const resolved = await resolveRunArg(arg, cwd);
        const loaded = await loadFactory(resolved.factoryPath);
        const factoryName = loaded.factory.name;
        const briefMode = loaded.factory.brief;

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

        const registry = (io.buildRegistry ?? defaultRegistry)();
        const result = await runFactory(loaded, {
          registry,
          brief: resolved.kind === "brief" ? resolved.brief : undefined,
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

        if (result.status === "succeeded") {
          exitCode = 0;
          return;
        }
        switch (result.reason) {
          case "budget_exhausted":
            exitCode = 3;
            io.stderr.write(
              `Run failed: budget exhausted${result.proximateNodeId ? ` at node "${result.proximateNodeId}"` : ""}\n`,
            );
            return;
          case "node_failed":
          case "graph_drained":
          case "unknown_executor":
            exitCode = 2;
            io.stderr.write(
              `Run failed: ${result.reason}${result.proximateNodeId ? ` at node "${result.proximateNodeId}"` : ""}\n`,
            );
            return;
          default:
            exitCode = 2;
            return;
        }
      } catch (err) {
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
        } else {
          io.stderr.write(`Error: ${(err as Error).message}\n`);
        }
        exitCode = 1;
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
    // commander.exitOverride throws CommanderError on --help, --version, or
    // usage errors. Map them: --help and --version exit 0; everything else 1.
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

// Direct invocation guard. When running as the bin entrypoint, parse argv and
// exit with the returned code.
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
