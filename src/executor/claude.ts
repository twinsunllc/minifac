// Claude executor.
//
// Wire format note: the `claude` CLI runs in stream-json mode (both input and
// output). For v0 we frame the prior run history plus the node's prompt as a
// SINGLE user message. The message's `content` is a string that starts with a
// JSON-serialized preamble of `ctx.history` (each entry is
// `{ nodeId, iteration, emittedAt, event }`) followed by a separator and the
// raw prompt. Concretely the line we write to stdin looks like:
//
//   {"type":"user","message":{"role":"user","content":"<history JSON>\n\n---\n\n<prompt>"}}
//
// followed by a newline; stdin is then closed.
//
// Trade-offs:
// - Simple, single-frame envelope. We don't pretend to replay prior turns as
//   real assistant/user messages — that would require role inference we don't
//   want to commit to in v0.
// - The wire format is snapshot-tested so any change is deliberate.
// - All knowledge of the CLI surface lives in this file.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import type {
  NodeEvent,
  NodeExecutor,
  ResolvedNode,
  RunContext,
  RunHistoryEntry,
} from "./types.js";

const WithSchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().optional(),
    args: z.array(z.string()).optional(),
  })
  .strict();

export type ClaudeWith = z.infer<typeof WithSchema>;

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => ChildProcess;

export interface ClaudeExecutorOptions {
  /** Injectable spawn for testing. Defaults to `node:child_process` spawn. */
  spawn?: SpawnLike;
  /** The binary to invoke. Defaults to `claude`. */
  binary?: string;
}

export function buildStreamJsonInput(history: readonly RunHistoryEntry[], prompt: string): string {
  // Single JSON line. We serialize history as a JSON array preamble inside
  // the user message content. Newline terminates the frame.
  const preamble = JSON.stringify(history);
  const content = `${preamble}\n\n---\n\n${prompt}`;
  const envelope = {
    type: "user",
    message: { role: "user", content },
  };
  return `${JSON.stringify(envelope)}\n`;
}

export class ClaudeExecutor implements NodeExecutor {
  readonly type = "claude";

  private readonly spawn: SpawnLike;
  private readonly binary: string;

  constructor(options: ClaudeExecutorOptions = {}) {
    this.spawn = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
    this.binary = options.binary ?? "claude";
  }

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    const parsed = WithSchema.safeParse(node.with ?? {});
    if (!parsed.success) {
      yield {
        kind: "status",
        status: "failed",
        meta: { reason: "invalid_with", error: parsed.error.format() },
      };
      return;
    }

    const { prompt, model, args: extraArgs } = parsed.data;
    // --input-format / --output-format only take effect with --print. Verbose
    // is required for stream-json output to actually stream message-by-message.
    const cliArgs: string[] = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      ...(model ? ["--model", model] : []),
      ...(extraArgs ?? []),
    ];

    let child: ChildProcess;
    try {
      child = this.spawn(this.binary, cliArgs, { cwd: ctx.cwd });
    } catch (err) {
      yield {
        kind: "status",
        status: "failed",
        meta: {
          reason: "spawn_error",
          error: (err as Error).message,
        },
      };
      return;
    }

    // Bridge stdout/stderr + exit into an async queue.
    type Item = { kind: "event"; event: NodeEvent } | { kind: "done"; code: number | null };

    const queue: Item[] = [];
    let resolveWait: (() => void) | null = null;
    const wake = () => {
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };

    // Track spawn errors (ENOENT etc). When the binary is missing, Node may
    // emit `error` without ever emitting `exit`; treat the error as a synthetic
    // terminal so the consumer unblocks. Boxed because TS control-flow
    // narrowing doesn't track closure mutation through a plain `let`.
    const errBox: { value: NodeJS.ErrnoException | null } = { value: null };
    let terminalEmitted = false;
    child.on("error", (err: NodeJS.ErrnoException) => {
      errBox.value = err;
      if (!terminalEmitted) {
        queue.push({ kind: "done", code: null });
        terminalEmitted = true;
        wake();
      }
    });

    // Write stdin synchronously then close it. Suppress EPIPE if the child
    // already exited (e.g. spawn ENOENT).
    const payload = buildStreamJsonInput(ctx.history, prompt);
    if (child.stdin) {
      child.stdin.on("error", () => {
        /* ignore; surfaced via child error/exit */
      });
      try {
        child.stdin.write(payload);
        child.stdin.end();
      } catch {
        /* ignore; surfaced via child error/exit */
      }
    }

    const bindLineStream = (
      stream: NodeJS.ReadableStream | null,
      eventKind: "stdout" | "stderr",
    ): void => {
      if (!stream) return;
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.length > 0) {
            queue.push({ kind: "event", event: { kind: eventKind, line } });
            wake();
          }
          idx = buffer.indexOf("\n");
        }
      });
      stream.on("end", () => {
        if (buffer.length > 0) {
          queue.push({
            kind: "event",
            event: { kind: eventKind, line: buffer },
          });
          buffer = "";
          wake();
        }
      });
    };

    bindLineStream(child.stdout, "stdout");
    bindLineStream(child.stderr, "stderr");

    child.on("exit", (code) => {
      if (terminalEmitted) return;
      queue.push({ kind: "done", code });
      terminalEmitted = true;
      wake();
    });

    while (true) {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;
        if (item.kind === "event") {
          yield item.event;
        } else {
          // Final status.
          if (errBox.value && errBox.value.code === "ENOENT") {
            yield {
              kind: "status",
              status: "failed",
              meta: { reason: "missing_binary", binary: this.binary },
            };
            return;
          }
          if (item.code === 0) {
            yield { kind: "status", status: "succeeded", meta: { exitCode: 0 } };
          } else {
            yield {
              kind: "status",
              status: "failed",
              meta: { exitCode: item.code },
            };
          }
          return;
        }
      }
      // Check for spawn error + ENOENT before waiting (some shims fire it
      // synchronously and never emit "exit").
      if (errBox.value && errBox.value.code === "ENOENT" && queue.length === 0) {
        yield {
          kind: "status",
          status: "failed",
          meta: { reason: "missing_binary", binary: this.binary },
        };
        return;
      }
      await new Promise<void>((resolve) => {
        resolveWait = resolve;
      });
    }
  }
}
