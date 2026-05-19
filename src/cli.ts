#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ClaudeExecutor } from "./executor/claude.js";
import { ExecutorRegistry } from "./executor/registry.js";
import { FactoryLoadError, loadFactory } from "./factory/loader.js";
import { runFactory } from "./runner/run.js";

export interface CliIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /**
   * Optional injectable factory for the executor registry. Useful for tests
   * that don't want the real Claude executor wired up.
   */
  buildRegistry?: () => ExecutorRegistry;
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
    .description("Run a factory YAML file end-to-end.")
    .argument("<factory>", "path to a factory YAML file")
    .action(async (factoryPath: string) => {
      try {
        const loaded = await loadFactory(factoryPath);
        const registry = (io.buildRegistry ?? defaultRegistry)();
        const result = await runFactory(loaded, {
          registry,
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
        } else {
          io.stderr.write(`Error: ${(err as Error).message}\n`);
        }
        exitCode = 1;
      }
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
