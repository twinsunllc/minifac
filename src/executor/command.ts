// Command executor.
//
// Runs a node's declared `with.commands` in order, with no model dispatch,
// and maps what they did to the node's terminal status, its failure reason
// and a `result` value written to `<outputs_dir>/result.json`. Each command
// is `/bin/sh -c <run>` in its own process group; the group is killed at the
// command's timeout, when the run's abort signal fires, and again once the
// command exits, so nothing a command started outlives the node. Live groups
// are also killed when the minifac process exits or receives SIGINT, SIGTERM
// or SIGHUP (see `killAllCommandGroups`).
//
// Shape, defaults and rationale: `docs/decisions/0051-Command-Executor.md`
// and the `command-executor` capability spec.

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { NodeEvent, NodeExecutor, ResolvedNode, RunContext } from "./types.js";

const COMMAND_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

/** Default per-command timeout, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 600;
/** Default wait between SIGTERM and SIGKILL of a timed-out command's group. */
export const DEFAULT_KILL_GRACE_MS = 5000;
/** Default byte bound on each of a command's `stdout_tail` / `stderr_tail`. */
export const DEFAULT_TAIL_BYTES = 8192;
/** Bound on the stdout kept for a `result_from` command's JSON. */
export const RESULT_FROM_MAX_BYTES = 4 * 1024 * 1024;

const REASON_LINE_RE = /^REASON:[ \t]*(.*)$/;

const ExpectSchema = z
  .object({
    exit: z.union([z.number().int(), z.array(z.number().int()).min(1)]),
  })
  .strict();

const CommandEntrySchema = z
  .object({
    id: z.string().min(1).regex(COMMAND_ID_RE, "command id must match [a-zA-Z_][a-zA-Z0-9_-]*"),
    run: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    expect: ExpectSchema.optional(),
    tool: z.string().min(1).optional(),
  })
  .strict();

export const CommandWithSchema = z
  .object({
    commands: z.array(CommandEntrySchema).min(1, "commands must list at least one command"),
    continue_on_red: z.boolean().optional(),
    result_from: z.string().min(1).optional(),
    result_file: z.string().min(1).optional(),
    // Carried, not read: a `uses:` node's `with.secrets` is merged into the
    // inlined step's `with` (ADR 0046), and the consumer that reads it is
    // outside this executor.
    secrets: z.array(z.unknown()).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    val.commands.forEach((cmd, i) => {
      if (seen.has(cmd.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["commands", i, "id"],
          message: `duplicate command id \`${cmd.id}\``,
        });
      }
      seen.add(cmd.id);
    });
    if (val.result_from !== undefined && val.result_file !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result_from"],
        message: "`result_from` and `result_file` are mutually exclusive",
      });
    } else if (val.result_from !== undefined && !seen.has(val.result_from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result_from"],
        message: `\`result_from\` names no declared command (\`${val.result_from}\`)`,
      });
    }
  });

export type CommandWith = z.infer<typeof CommandWithSchema>;
export type CommandEntry = z.infer<typeof CommandEntrySchema>;

function formatPath(p: ReadonlyArray<string | number>): string {
  let out = "";
  for (const seg of p) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out.length === 0 ? seg : `.${seg}`;
  }
  return out;
}

/**
 * Validate a `command` node's or step's `with:`. Returns `null` when it is
 * valid, else the first issue as `<key path>: <message>`, the key path
 * relative to `with` (for example `commands[1].id`).
 */
export function validateCommandWith(raw: unknown): string | null {
  const parsed = CommandWithSchema.safeParse(raw ?? {});
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (!issue) return "(root): validation error";
  let key = formatPath(issue.path);
  let message = issue.message;
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    const keys = issue.keys;
    key = formatPath([...issue.path, keys[0] ?? ""]);
    message = `unknown key${keys.length > 1 ? "s" : ""} ${keys.map((k) => `\`${k}\``).join(", ")}`;
  }
  return `${key.length > 0 ? key : "(root)"}: ${message}`;
}

/** One command's record in the node's `result.commands`. */
export interface CommandRecord {
  id: string;
  /** `null` when the command was never spawned, failed to start, or ended on a signal. */
  exit_code: number | null;
  /** The signal that ended the command's shell, if one did. */
  signal: string | null;
  duration_ms: number;
  host_missing: boolean;
  timed_out: boolean;
  /** Whether the command met its `expect`. */
  met: boolean;
  stdout_tail: string;
  stderr_tail: string;
}

export interface CommandExecutorOptions {
  /** Wait between SIGTERM and SIGKILL of a timed-out group. Default 5000. */
  killGraceMs?: number;
  /** Byte bound on each tail. Default 8192. */
  tailBytes?: number;
}

/** Last `limit` bytes of `buf`, cut at a UTF-8 character boundary. */
function tailOf(buf: Buffer, limit: number): string {
  if (buf.length <= limit) return buf.toString("utf8");
  let start = buf.length - limit;
  // Skip continuation bytes (10xxxxxx) so the tail never opens mid-character.
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/** Bytes kept from the end of a stream, at most `limit`. */
class TailBuffer {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    const joined = Buffer.concat([this.buf, chunk]);
    // Keep a few bytes over the limit so `tailOf` can find a char boundary.
    const keep = this.limit + 4;
    this.buf = joined.length > keep ? joined.subarray(joined.length - keep) : joined;
  }
  text(): string {
    return tailOf(this.buf, this.limit);
  }
}

/** A single-consumer queue the child's stream handlers push events into. */
class EventChannel {
  private readonly items: NodeEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: NodeEvent): void {
    this.items.push(event);
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  async *drain(): AsyncGenerator<NodeEvent> {
    while (true) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

/** Process groups of commands that have been spawned and not yet settled. */
const liveGroups = new Set<number>();

/**
 * Send `signal` (default SIGKILL) to the process group of every command this
 * module has spawned and not yet seen settle. Synchronous, so it is safe in a
 * `process.on("exit")` handler.
 *
 * The executor calls it itself from `exit`, and from the SIGINT, SIGTERM and
 * SIGHUP handlers it installs when it spawns its first command when no other
 * listener for that signal is registered. An embedder that handles those
 * signals itself owns the drain; it, or one that ends its process some other
 * way (for example `process.abort()`), should call this to stop commands.
 * Nothing can run on SIGKILL of minifac itself: groups survive that.
 */
export function killAllCommandGroups(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pgid of liveGroups) killGroup(pgid, signal);
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
let processHooksInstalled = false;

/**
 * Install, once per process, the hooks that keep a command's group from
 * outliving minifac. A child in its own group does not get the signals a
 * terminal or a supervisor sends to minifac's group, so they are forwarded.
 *
 * The signal listener is prepended, so it runs before any listener the host
 * process has, while those are all still registered. When it is the only
 * listener, the process is about to die by that signal: it kills every live
 * group, removes itself and re-raises the signal, so the process ends the way
 * it would have with no listener at all. When the host has its own listener,
 * it does nothing: the host owns the shutdown, and a graceful drain lets
 * running commands finish. Their groups still die on `exit`, when the host
 * fires the run's `abortSignal`, or when it calls {@link killAllCommandGroups}.
 */
function installProcessHooks(): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;
  process.on("exit", () => killAllCommandGroups("SIGKILL"));
  for (const sig of FORWARDED_SIGNALS) {
    const onSignal = (): void => {
      if (process.listenerCount(sig) === 1) {
        killAllCommandGroups("SIGKILL");
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      }
    };
    process.prependListener(sig, onSignal);
  }
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Resolve `tool` the way a shell would: a value containing `/` is a path
 * (relative to `cwd`), anything else is searched on `pathVar`. */
async function resolveTool(
  tool: string,
  cwd: string,
  pathVar: string | undefined,
): Promise<string | null> {
  if (tool.includes("/")) {
    const abs = path.resolve(cwd, tool);
    return (await isExecutableFile(abs)) ? abs : null;
  }
  for (const dir of (pathVar ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, tool);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

interface SpawnOutcome {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  stdoutTail: string;
  stderrTail: string;
  /** Full stdout, only when captured for `result_from`; `null` if it overflowed. */
  stdout: string | null;
  lastReason: string | null;
  /** The run's abort signal fired while the command was live. */
  aborted: boolean;
}

interface RunningCommand {
  pid: number | undefined;
  events: AsyncGenerator<NodeEvent>;
  outcome: Promise<SpawnOutcome>;
}

function startCommand(
  cmd: CommandEntry,
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: {
    killGraceMs: number;
    tailBytes: number;
    captureStdout: boolean;
    abortSignal: AbortSignal | undefined;
  },
): RunningCommand {
  const channel = new EventChannel();
  const stdoutTail = new TailBuffer(opts.tailBytes);
  const stderrTail = new TailBuffer(opts.tailBytes);
  const captured: Buffer[] = [];
  let capturedBytes = 0;
  let overflowed = false;
  let lastReason: string | null = null;
  let timedOut = false;
  let aborted = false;

  installProcessHooks();
  const child: ChildProcess = nodeSpawn("/bin/sh", ["-c", cmd.run], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid !== undefined) liveGroups.add(pid);

  const lineSplitter = (kind: "stdout" | "stderr") => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const emit = (line: string) => {
      const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (kind === "stdout") {
        const m = clean.match(REASON_LINE_RE);
        if (m) lastReason = m[1] ?? "";
      }
      channel.push({ kind, line: clean });
    };
    return {
      write(chunk: Buffer) {
        pending += decoder.write(chunk);
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const p of parts) emit(p);
      },
      end() {
        pending += decoder.end();
        if (pending.length > 0) emit(pending);
        pending = "";
      },
    };
  };
  const outLines = lineSplitter("stdout");
  const errLines = lineSplitter("stderr");

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutTail.push(chunk);
    if (opts.captureStdout && !overflowed) {
      if (capturedBytes + chunk.length > RESULT_FROM_MAX_BYTES) {
        overflowed = true;
        captured.length = 0;
      } else {
        captured.push(chunk);
        capturedBytes += chunk.length;
      }
    }
    outLines.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail.push(chunk);
    errLines.write(chunk);
  });

  const outcome = new Promise<SpawnOutcome>((resolve) => {
    let graceTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let spawnError: string | null = null;

    // SIGTERM the group, then SIGKILL it after the grace. The shell's exit
    // (handled below) SIGKILLs the group in any case.
    const terminate = () => {
      if (graceTimer) return;
      killGroup(pid, "SIGTERM");
      graceTimer = setTimeout(() => killGroup(pid, "SIGKILL"), opts.killGraceMs);
    };

    const timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        terminate();
      },
      (cmd.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    );

    const onAbort = () => {
      aborted = true;
      clearTimeout(timeoutTimer);
      terminate();
    };
    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (closeTimer) clearTimeout(closeTimer);
      opts.abortSignal?.removeEventListener("abort", onAbort);
      if (pid !== undefined) liveGroups.delete(pid);
      outLines.end();
      errLines.end();
      if (spawnError !== null) channel.push({ kind: "stderr", line: spawnError });
      channel.close();
      resolve({
        exitCode,
        signal: exitSignal,
        timedOut,
        spawnError,
        stdoutTail: stdoutTail.text(),
        stderrTail: spawnError !== null ? spawnError : stderrTail.text(),
        stdout: opts.captureStdout && !overflowed ? Buffer.concat(captured).toString("utf8") : null,
        lastReason,
        aborted,
      });
    };

    child.on("error", (err) => {
      spawnError = `failed to start: ${err.message}`;
      finish();
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      // The shell is gone; take whatever it left running in its group with
      // it. That also closes the pipes a backgrounded grandchild held open,
      // which `close` below waits for.
      killGroup(pid, "SIGKILL");
      // A process that left the group (setsid) can still hold a pipe; do
      // not wait on it forever.
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, opts.killGraceMs);
    });
    child.on("close", () => finish());
  });

  return { pid, events: channel.drain(), outcome };
}

function expectedExits(cmd: CommandEntry): number[] {
  const exit = cmd.expect?.exit ?? 0;
  return Array.isArray(exit) ? exit : [exit];
}

function redReason(
  cmd: CommandEntry,
  rec: CommandRecord,
  spawnError: string | null,
  aborted: boolean,
): string {
  if (rec.host_missing) return `${cmd.id}: host_missing ${cmd.tool ?? ""}`.trimEnd();
  if (spawnError !== null) return `${cmd.id}: ${spawnError}`;
  if (aborted) return `${cmd.id}: aborted`;
  if (rec.timed_out) {
    return `${cmd.id}: timed out after ${cmd.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS}s`;
  }
  if (rec.exit_code === null) return `${cmd.id}: killed by ${rec.signal ?? "signal"}`;
  return `${cmd.id}: exit ${rec.exit_code}, expected [${expectedExits(cmd).join(", ")}]`;
}

/** A `result_from` command's stdout without its `REASON:` lines, which are
 * the executor's protocol rather than part of the JSON payload. */
function withoutReasonLines(stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => !REASON_LINE_RE.test(line.endsWith("\r") ? line.slice(0, -1) : line))
    .join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected a JSON object, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
  return value as Record<string, unknown>;
}

/** `true` when `child` is `parent` or lies beneath it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function writeResultAtomically(outputsDir: string, value: unknown): Promise<void> {
  await mkdir(outputsDir, { recursive: true });
  const final = path.join(outputsDir, "result.json");
  const tmp = path.join(outputsDir, `.result.json.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, final);
}

export class CommandExecutor implements NodeExecutor {
  readonly type = "command";
  readonly supportsMcp = false;
  readonly supportsNudge = false;
  readonly supportsResume = false;

  private readonly killGraceMs: number;
  private readonly tailBytes: number;

  constructor(options: CommandExecutorOptions = {}) {
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  }

  async *run(node: ResolvedNode, ctx: RunContext): AsyncIterable<NodeEvent> {
    yield { kind: "status", status: "started" };

    const issue = validateCommandWith(node.with ?? {});
    if (issue !== null) {
      yield {
        kind: "status",
        status: "failed",
        meta: {
          reason: "invalid_with",
          message: `Invalid \`with:\` for executor \`command\`: ${issue}`,
        },
        outcome: "error",
      };
      return;
    }
    const spec = CommandWithSchema.parse(node.with ?? {});

    const records: CommandRecord[] = [];
    let firstRed: string | null = null;
    // ADR 0052: a red command that produced no exit code (host_missing, a
    // spawn error, a signal), timed out, or was aborted is an error, not a
    // judged failure. A timed-out or aborted command can still exit with a
    // code of its own if it handles SIGTERM, so those are checked by name.
    let errored = false;
    let lastReason: string | null = null;
    let resultFromStdout: string | null | undefined;
    let running: RunningCommand | null = null;
    let aborted = false;

    try {
      for (const cmd of spec.commands) {
        const cwd = path.resolve(ctx.cwd, cmd.cwd ?? ".");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ...(ctx.commandEnv?.[cmd.id] ?? {}),
          MINIFAC_OUTPUTS_DIR: ctx.outputsDir,
        };
        const started = Date.now();
        let rec: CommandRecord;
        let spawnError: string | null = null;
        let cmdAborted = false;

        const toolMissing =
          cmd.tool !== undefined && (await resolveTool(cmd.tool, cwd, env.PATH)) === null;
        // A cancelled run starts nothing more. Checked after the last await
        // before the spawn, which attaches the abort listener synchronously.
        if (ctx.abortSignal?.aborted) {
          aborted = true;
          break;
        }
        if (toolMissing) {
          rec = {
            id: cmd.id,
            exit_code: null,
            signal: null,
            duration_ms: 0,
            host_missing: true,
            timed_out: false,
            met: false,
            stdout_tail: "",
            stderr_tail: "",
          };
          yield {
            kind: "stderr",
            line: `command ${cmd.id}: host_missing: tool \`${cmd.tool}\` does not resolve (cwd ${cwd}); not run`,
          };
        } else {
          running = startCommand(cmd, cwd, env, {
            killGraceMs: this.killGraceMs,
            tailBytes: this.tailBytes,
            captureStdout: spec.result_from === cmd.id,
            abortSignal: ctx.abortSignal,
          });
          for await (const event of running.events) yield event;
          const out = await running.outcome;
          running = null;
          spawnError = out.spawnError;
          cmdAborted = out.aborted;
          if (out.lastReason !== null) lastReason = out.lastReason;
          if (spec.result_from === cmd.id) resultFromStdout = out.stdout;
          const met =
            out.spawnError === null &&
            !out.timedOut &&
            !out.aborted &&
            out.exitCode !== null &&
            expectedExits(cmd).includes(out.exitCode);
          rec = {
            id: cmd.id,
            exit_code: out.exitCode,
            signal: out.signal,
            duration_ms: Date.now() - started,
            host_missing: false,
            timed_out: out.timedOut,
            met,
            stdout_tail: out.stdoutTail,
            stderr_tail: out.stderrTail,
          };
        }

        records.push(rec);
        if (!rec.met && (rec.exit_code === null || rec.timed_out)) errored = true;
        if (cmdAborted) {
          aborted = true;
          if (firstRed === null) firstRed = redReason(cmd, rec, spawnError, true);
          break;
        }
        if (!rec.met) {
          if (firstRed === null) firstRed = redReason(cmd, rec, spawnError, false);
          if (spec.continue_on_red !== true) break;
        }
      }
    } finally {
      // Reached early only when the consumer stopped iterating: leave nothing
      // of the current command behind.
      if (running !== null) killGroup(running.pid, "SIGKILL");
    }
    if (aborted && firstRed === null) firstRed = "aborted";
    if (aborted) errored = true;

    // Emitted keys. A `result_from` command that never ran (an earlier red
    // stopped the node) emits nothing; a `result_file` that is absent while
    // a command was red is likewise nothing more to report.
    let emitted: Record<string, unknown> = {};
    let parseFailure: string | null = null;
    if (spec.result_from !== undefined && resultFromStdout !== undefined) {
      if (resultFromStdout === null) {
        parseFailure = `result_parse: ${spec.result_from}: stdout exceeded ${RESULT_FROM_MAX_BYTES} bytes`;
      } else {
        try {
          emitted = parseJsonObject(withoutReasonLines(resultFromStdout));
        } catch (err) {
          parseFailure = `result_parse: ${spec.result_from}: ${(err as Error).message}`;
        }
      }
    } else if (spec.result_file !== undefined) {
      const loaded = await this.readResultFile(spec.result_file, ctx.outputsDir, firstRed !== null);
      if (typeof loaded === "string") parseFailure = loaded;
      else emitted = loaded;
    }

    if (Object.hasOwn(emitted, "commands")) {
      yield {
        kind: "stderr",
        line: "command executor: emitted result key `commands` is replaced by the per-command list",
      };
    }
    const result = { ...emitted, commands: records };
    await writeResultAtomically(ctx.outputsDir, result);

    if (firstRed === null && parseFailure === null) {
      yield { kind: "status", status: "succeeded", meta: { commands: records } };
      return;
    }
    // The result failing to parse outranks a REASON line: a router acting on
    // that reason would find none of the keys the script meant to send.
    const reason = parseFailure ?? lastReason ?? firstRed ?? "command_failed";
    yield {
      kind: "status",
      status: "failed",
      meta: { reason: "command_failed", sentinel: reason, commands: records },
      ...(errored || parseFailure !== null ? { outcome: "error" as const } : {}),
    };
  }

  /** The `result_file` object, or a `result_parse:` failure reason. */
  private async readResultFile(
    declared: string,
    outputsDir: string,
    anyRed: boolean,
  ): Promise<Record<string, unknown> | string> {
    const label = `result_parse: ${declared}`;
    let text: string;
    try {
      // Compared after resolving symlinks, so neither `..` nor a link
      // planted in the outputs dir reads a file from outside it.
      const realAbs = await realpath(path.resolve(outputsDir, declared));
      if (!isWithin(await realpath(outputsDir), realAbs)) {
        return `${label}: resolves outside run.outputs_dir`;
      }
      text = await readFile(realAbs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && anyRed) return {};
      return `${label}: ${(err as Error).message}`;
    }
    try {
      return parseJsonObject(text);
    } catch (err) {
      return `${label}: ${(err as Error).message}`;
    }
  }
}
