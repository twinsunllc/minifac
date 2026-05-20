// Claude executor.
//
// ## Wire format — stdin
//
// The `claude` CLI runs in stream-json mode (both input and output). For v0 we
// frame the structured prior-results plus the node's prompt as a SINGLE user
// message. The message's `content` is a string that starts with a JSON-
// serialized preamble of `ctx.priorResults` (each entry is a `NodeResult`:
// `{ nodeId, iteration, status, reason, startedAt, endedAt }`) followed by a
// separator and the raw prompt. Concretely the line we write to stdin looks
// like:
//
//   {"type":"user","message":{"role":"user","content":"<priorResults JSON>\n\n---\n\n<prompt>"}}
//
// followed by a newline; stdin is then closed. For the first node in a run
// the preamble is the empty array literal `[]`.
//
// The wire format is snapshot-tested so any change is deliberate.
//
// See `docs/decisions/0014-Structured-Prior-Results.md` — this replaced
// the prior run-wide event-history preamble, which inflated per-node
// prompts past the model's context window.
//
// ## Wire format — argv
//
// The base argv is always (in this order):
//
//   --print --verbose --input-format stream-json --output-format stream-json
//   [--model <model>]
//   [authority flags, see below]
//   [...with.args]
//
// Typed authority flags ALWAYS precede `with.args` so that the user-supplied
// passthrough cannot accidentally override them (without flag deduping logic
// we'd need to add).
//
// ### Authority knobs (all optional, opt-in; defaults emit no flag)
//
// - `permission_mode` (YAML snake_case): one of `"default"`, `"accept_edits"`,
//   `"bypass_permissions"`. Maps to `--permission-mode <camelCase-value>`.
//   The CLI flag value uses camelCase (`acceptEdits`, `bypassPermissions`)
//   confirmed against `claude --help` (Claude Code CLI v2.x). The YAML key
//   stays snake_case per repo convention; the executor does the translation.
//   `"default"` emits NO flag (so the CLI's own default applies).
// - `allowed_tools` (string[]): non-empty array → `--allowedTools <a,b,c>`
//   as a single argument with comma-joined values. Spelling pinned to
//   `--allowedTools` (camelCase). The CLI also accepts `--allowed-tools`
//   but we standardize on the camelCase form to match the proposal.
// - `add_dirs` (string[]): non-empty array → `--add-dir <dir>` repeated once
//   per element, in array order. The CLI accepts `--add-dir` as a repeatable
//   flag.
//
// Validation: unknown keys in `with:` are rejected (strict zod). Unknown
// `permission_mode` values, empty-string elements in `allowed_tools` /
// `add_dirs`, and missing `prompt` all yield a terminal
// `{ kind: "status", status: "failed", meta: { reason: "invalid_with", ... } }`
// event with NO child spawn.
//
// ## Status precedence — sentinel beats exit code
//
// The terminal status is derived in this order:
//
// 1. Sentinel marker in the FINAL stream-json `result` event's `result`
//    field (the model's final assistant text), matching:
//
//      /^MINIFAC_STATUS:[ \t]*(succeeded|failed)\b[ \t]*(?:\r?\nREASON:[ \t]*(.*))?/m
//
//    If matched, the captured status determines the terminal event,
//    REGARDLESS of the child's exit code (sentinel wins in both
//    directions). `meta.reason` is `"sentinel_succeeded"` or
//    `"sentinel_failed"`; `meta.exitCode` carries the raw exit code for
//    debugging; on failure, `meta.sentinel` carries the captured REASON
//    text (or `undefined` if no REASON line was present).
//
// 2. If no sentinel matched (or no `result` event was seen), the executor
//    falls back to the existing exit-code semantics: code `0` → `succeeded`,
//    non-zero → `failed`. `meta.exitCode` is always populated.
//
// Only the FINAL `result` event is inspected — earlier sentinels (e.g. in
// mid-conversation tool-call planning) are ignored. This is implemented by
// keeping a rolling "last `result.result` seen" string and scanning it
// once after stream drain.
//
// ## Sentinel instruction auto-injection
//
// By default the executor auto-appends a canonical sentinel-emission
// instruction block (`SENTINEL_INSTRUCTIONS`, defined below) to the
// outgoing prompt, after a blank-line separator and before the prompt
// is wrapped in the stream-json envelope. The injected block teaches
// the model the two acceptable trailing shapes
// (`MINIFAC_STATUS: succeeded` and `MINIFAC_STATUS: failed` + `REASON:`),
// that the marker must appear in its final assistant message, and that
// the marker must be the last thing in the message.
//
// The runner owns both halves of the sentinel contract: it instructs
// the model on emission (via the appended block) and parses the response
// (via `SENTINEL_REGEX`). The two are defined adjacently below so a
// future format change touches one file.
//
// ### Sentinel knob (sentinel-side, not authority-side)
//
// - `emit_sentinel_instructions` (boolean, optional, default `true`):
//   set to `false` to opt out of the auto-injection. The executor still
//   scans the response for the sentinel marker per the parse rules
//   above — opting out is a prompt-side knob only; response-side
//   parsing is unaffected.
//
// See the canonical spec under `openspec/specs/node-executor/spec.md`
// (requirements: "Claude executor uses stream-json...",
// "Per-node authority controls in claude executor `with:`",
// "Status signaling via sentinel marker",
// "Per-node sentinel-injection opt-out in claude executor `with:`").

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import type {
  NodeEvent,
  NodeExecutor,
  NodeResult,
  ResolvedNode,
  RunContext,
} from "./types.js";

const WithSchema = z
  .object({
    prompt: z.string().min(1),
    model: z.string().optional(),
    args: z.array(z.string()).optional(),
    permission_mode: z.enum(["default", "accept_edits", "bypass_permissions"]).optional(),
    // Use `.optional()` over `.nonempty()` so an explicit empty array is
    // accepted by the parser; we then treat empty as "emit no flag" when
    // constructing argv. This keeps validation focused on element shape
    // (non-empty strings) rather than collection size.
    allowed_tools: z.array(z.string().min(1)).optional(),
    add_dirs: z.array(z.string().min(1)).optional(),
    // Sentinel-injection opt-out. Default (omitted or `true`) → executor
    // appends `SENTINEL_INSTRUCTIONS` to the outgoing prompt. `false`
    // suppresses the appended block. Response-side parsing is unaffected
    // by this knob — see `SENTINEL_REGEX` below.
    emit_sentinel_instructions: z.boolean().optional(),
  })
  .strict();

export type ClaudeWith = z.infer<typeof WithSchema>;

/**
 * Canonical sentinel-emission instruction block appended to outgoing
 * prompts by default. The runner owns this contract (see decision
 * `docs/decisions/0007-Sentinel-Runner-Injects.md`): factories declare
 * per-node success/failure criteria; the runner teaches the model the
 * mechanics.
 *
 * Cross-reference: `SENTINEL_REGEX` (below) parses the response side
 * of the same contract — the two MUST stay in sync.
 */
export const SENTINEL_INSTRUCTIONS = `## Status signaling

Your final assistant message MUST end with a \`MINIFAC_STATUS:\` line
that tells the runner whether this node succeeded or failed. The
runner reads this line out of your final assistant text; nothing
else in the message decides the outcome.

- On success, end your final message with exactly this line and
  nothing after it:

      MINIFAC_STATUS: succeeded

- On failure, end your final message with exactly these two lines
  and nothing after them:

      MINIFAC_STATUS: failed
      REASON: <one-line description of what blocked the node>

The \`MINIFAC_STATUS:\` line MUST be the last thing in your final
assistant message.`;

/**
 * Sentinel regex for in-band status signaling from the spawned model.
 *
 * Note: the proposal/design/spec all stated this regex as
 *
 *   /^MINIFAC_STATUS:\s*(succeeded|failed)\b\s*(?:\nREASON:\s*(.*))?/m
 *
 * but that form is internally inconsistent — `\s*` matches `\n`, so it
 * greedily consumes the newline before `REASON:`, and the optional
 * REASON-capture group can never match. The spec scenario explicitly
 * requires `MINIFAC_STATUS: failed\nREASON: nothing got done` to
 * produce `sentinel: "nothing got done"`, which is the ground truth.
 *
 * We narrow the trailing whitespace class to `[ \t]*` (horizontal
 * whitespace only) so the optional REASON line is reachable. Decision
 * pinned by the sentinel tests below.
 *
 * Cross-reference: `SENTINEL_INSTRUCTIONS` (above) is the prompt-side
 * counterpart that teaches the model the format this regex parses.
 */
export const SENTINEL_REGEX =
  /^MINIFAC_STATUS:[ \t]*(succeeded|failed)\b[ \t]*(?:\r?\nREASON:[ \t]*(.*))?/m;

/** YAML snake_case `permission_mode` → CLI camelCase flag value. */
const PERMISSION_MODE_FLAG: Record<NonNullable<ClaudeWith["permission_mode"]>, string | null> = {
  default: null, // emit no flag — let the CLI's own default apply
  accept_edits: "acceptEdits",
  bypass_permissions: "bypassPermissions",
};

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

export function buildStreamJsonInput(
  priorResults: readonly NodeResult[],
  prompt: string,
): string {
  // Single JSON line. We serialize priorResults as a JSON array preamble
  // inside the user message content. Newline terminates the frame.
  const preamble = JSON.stringify(priorResults);
  const content = `${preamble}\n\n---\n\n${prompt}`;
  const envelope = {
    type: "user",
    message: { role: "user", content },
  };
  return `${JSON.stringify(envelope)}\n`;
}

/**
 * Build the full argv passed to the `claude` CLI from the validated `with:`
 * payload. Exported for snapshot testing — the argv shape is part of the
 * wire-format contract.
 */
export function buildCliArgs(w: ClaudeWith): string[] {
  const args: string[] = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];
  if (w.model) {
    args.push("--model", w.model);
  }
  if (w.permission_mode) {
    const flagValue = PERMISSION_MODE_FLAG[w.permission_mode];
    if (flagValue !== null) {
      args.push("--permission-mode", flagValue);
    }
  }
  if (w.allowed_tools && w.allowed_tools.length > 0) {
    args.push("--allowedTools", w.allowed_tools.join(","));
  }
  if (w.add_dirs && w.add_dirs.length > 0) {
    for (const dir of w.add_dirs) {
      args.push("--add-dir", dir);
    }
  }
  // `with.args` is the user-supplied passthrough. Always trails the typed
  // flags so it can't accidentally override them.
  if (w.args) {
    args.push(...w.args);
  }
  return args;
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

    const { prompt } = parsed.data;
    // Auto-inject the sentinel-emission instruction block by default.
    // Opt out with `emit_sentinel_instructions: false`. Response-side
    // parsing (see SENTINEL_REGEX) is unaffected by this knob.
    const effectivePrompt =
      parsed.data.emit_sentinel_instructions === false
        ? prompt
        : `${prompt}\n\n${SENTINEL_INSTRUCTIONS}`;
    const cliArgs = buildCliArgs(parsed.data);

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
    const payload = buildStreamJsonInput(ctx.priorResults, effectivePrompt);
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

    // Rolling "last `result` event's `result` field" — only the FINAL one
    // is inspected for the sentinel, so we just overwrite as new ones
    // arrive. JSON parse failures on a line are non-fatal: the line is
    // still emitted as a `stdout` event by the line-stream handler.
    const lastResultBox: { value: string | null } = { value: null };

    const bindLineStream = (
      stream: NodeJS.ReadableStream | null,
      eventKind: "stdout" | "stderr",
    ): void => {
      if (!stream) return;
      let buffer = "";
      stream.setEncoding("utf8");
      const consume = (line: string): void => {
        if (line.length === 0) return;
        queue.push({ kind: "event", event: { kind: eventKind, line } });
        // Sentinel detection: try parsing each stdout line as JSON and
        // looking for a `result` event with a string `result` field.
        // Earlier `result` events are overwritten; only the last is kept.
        if (eventKind === "stdout") {
          try {
            // biome-ignore lint/suspicious/noExplicitAny: untyped CLI stream-json
            const obj = JSON.parse(line) as any;
            if (
              obj &&
              typeof obj === "object" &&
              obj.type === "result" &&
              typeof obj.result === "string"
            ) {
              lastResultBox.value = obj.result;
            }
          } catch {
            /* non-JSON line; ignored for sentinel detection */
          }
        }
        wake();
      };
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          consume(line);
          idx = buffer.indexOf("\n");
        }
      });
      stream.on("end", () => {
        if (buffer.length > 0) {
          const tail = buffer;
          buffer = "";
          consume(tail);
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
          // Sentinel beats exit code in both directions. Inspect the
          // last `result` event's `result` field, if any.
          const exitCode = item.code;
          if (lastResultBox.value !== null) {
            const match = lastResultBox.value.match(SENTINEL_REGEX);
            if (match) {
              const captured = match[1];
              const reason = match[2];
              if (captured === "failed") {
                yield {
                  kind: "status",
                  status: "failed",
                  meta: {
                    reason: "sentinel_failed",
                    sentinel: reason,
                    exitCode,
                  },
                };
                return;
              }
              if (captured === "succeeded") {
                yield {
                  kind: "status",
                  status: "succeeded",
                  meta: { reason: "sentinel_succeeded", exitCode },
                };
                return;
              }
            }
          }
          if (exitCode === 0) {
            yield { kind: "status", status: "succeeded", meta: { exitCode: 0 } };
          } else {
            yield {
              kind: "status",
              status: "failed",
              meta: { exitCode },
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
