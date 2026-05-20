import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError, z } from "zod";
import {
  AUTHORING_QUESTIONS,
  type AuthoringAnswers,
  type AuthoringQuestionId,
  renderBrief,
} from "../brief/authoring.js";
import { loadBrief } from "../brief/loader.js";

export interface BriefCommandIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface BriefCommandOpts {
  name: string;
  from?: string;
  out?: string;
  force?: boolean;
  cwd: string;
  io: BriefCommandIO;
}

const REQUIRED_IDS: readonly AuthoringQuestionId[] = AUTHORING_QUESTIONS.filter(
  (q) => q.required,
).map((q) => q.id);

const ALL_IDS: readonly AuthoringQuestionId[] = AUTHORING_QUESTIONS.map((q) => q.id);

const AuthoringAnswersSchema = z
  .object({
    change: z.string(),
    factory: z.string(),
    background: z.string(),
    what_to_do: z.string(),
    acceptance_criteria: z.string(),
    out_of_scope: z.string().optional(),
    base_branch: z.string().optional(),
    model: z.string().optional(),
  })
  .strict();

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function describeAnswersError(err: ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "invalid answers file";
  const idList = ALL_IDS.join(" | ");
  if (issue.code === "unrecognized_keys") {
    const issueWithKeys = issue as unknown as { keys?: string[] };
    const keys = issueWithKeys.keys ?? [];
    return `unknown answer \`${keys[0] ?? "?"}\`; supported: ${idList}`;
  }
  const dotted = issue.path.join(".") || "(root)";
  if (issue.code === "invalid_type") {
    const it = issue as unknown as { received?: string; expected?: string };
    if (it.received === "undefined") {
      return `missing required answer \`${dotted}\``;
    }
    return `answer \`${dotted}\` must be a string`;
  }
  return `answer \`${dotted}\`: ${issue.message}`;
}

function computeIncompleteAt(answers: AuthoringAnswers): AuthoringQuestionId | undefined {
  for (const id of REQUIRED_IDS) {
    const v = answers[id];
    if (v === undefined || v === "") return id;
  }
  return undefined;
}

async function writeBriefFile(
  outPath: string,
  answers: AuthoringAnswers,
  incompleteAt: AuthoringQuestionId | undefined,
  io: BriefCommandIO,
  cwd: string,
): Promise<number> {
  const content = renderBrief(answers, incompleteAt ? { incompleteAt } : {});
  await writeFile(outPath, content, "utf8");
  try {
    await loadBrief(outPath, cwd);
  } catch (err) {
    io.stderr.write(`Wrote ${outPath} but it failed to load: ${(err as Error).message}\n`);
    return 1;
  }
  io.stdout.write(`${outPath}\n`);
  if (incompleteAt) {
    io.stderr.write(`(brief is incomplete; next question was \`${incompleteAt}\`)\n`);
  }
  return 0;
}

async function runFromMode(opts: BriefCommandOpts, outPath: string): Promise<number> {
  const fromPath = opts.from as string;
  const ext = path.extname(fromPath).toLowerCase();
  if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") {
    opts.io.stderr.write(
      `Unsupported --from file extension \`${ext}\`; supported: .yaml, .yml, .json\n`,
    );
    return 1;
  }
  let raw: string;
  try {
    raw = await readFile(fromPath, "utf8");
  } catch (err) {
    opts.io.stderr.write(`Could not read --from file ${fromPath}: ${(err as Error).message}\n`);
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
  } catch (err) {
    opts.io.stderr.write(`Failed to parse ${fromPath}: ${(err as Error).message}\n`);
    return 1;
  }
  let answers: AuthoringAnswers;
  try {
    answers = AuthoringAnswersSchema.parse(parsed) as AuthoringAnswers;
  } catch (err) {
    if (err instanceof ZodError) {
      opts.io.stderr.write(`${describeAnswersError(err)}\n`);
      return 1;
    }
    throw err;
  }
  return await writeBriefFile(outPath, answers, undefined, opts.io, opts.cwd);
}

// A minimal line reader: collects bytes from `stdin`, emits one line per
// newline. End-of-input resolves a pending request with `null`. Designed to
// be deterministic with a `PassThrough` stream in tests.
class LineReader {
  private buf = "";
  private lines: string[] = [];
  private ended = false;
  private pending: ((line: string | null) => void) | null = null;

  constructor(private stream: NodeJS.ReadableStream) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string | Buffer) => {
      this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      while (true) {
        const i = this.buf.indexOf("\n");
        if (i === -1) break;
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        // Strip trailing \r for CRLF inputs.
        this.lines.push(line.replace(/\r$/, ""));
      }
      this.drain();
    });
    stream.on("end", () => {
      if (this.buf.length > 0) {
        this.lines.push(this.buf);
        this.buf = "";
      }
      this.ended = true;
      this.drain();
    });
    stream.on("close", () => {
      this.ended = true;
      this.drain();
    });
  }

  private drain(): void {
    if (!this.pending) return;
    if (this.lines.length > 0) {
      const resolver = this.pending;
      this.pending = null;
      resolver(this.lines.shift() as string);
    } else if (this.ended) {
      const resolver = this.pending;
      this.pending = null;
      resolver(null);
    }
  }

  readLine(): Promise<string | null> {
    if (this.lines.length > 0) {
      return Promise.resolve(this.lines.shift() as string);
    }
    if (this.ended) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      this.pending = resolve;
    });
  }
}

interface InteractiveResult {
  answers: AuthoringAnswers;
  stopped: boolean;
}

async function runInteractive(opts: BriefCommandOpts): Promise<InteractiveResult> {
  const answers: AuthoringAnswers = {};
  const reader = new LineReader(opts.io.stdin);
  let stopped = false;

  for (const q of AUTHORING_QUESTIONS) {
    let preset: string | undefined;
    if (q.id === "change" && opts.name) preset = opts.name;
    const hint = q.required ? "(required)" : "(optional, blank to skip)";
    let firstTry = true;
    while (true) {
      const defaultHint = preset
        ? ` [${preset}]`
        : q.applies === "frontmatter" && q.default
          ? ` [${q.default}]`
          : "";
      opts.io.stdout.write(`${q.prompt} ${hint}${defaultHint}\n`);
      const line = await reader.readLine();
      if (line === null || line === ":q") {
        stopped = true;
        break;
      }
      const trimmed = line;
      if (trimmed === "") {
        if (preset) {
          answers[q.id] = preset;
          break;
        }
        if (q.applies === "frontmatter" && q.default) {
          answers[q.id] = q.default;
          break;
        }
        if (q.required) {
          if (firstTry) opts.io.stderr.write("(required)\n");
          firstTry = false;
          continue;
        }
        // optional blank: omit
        break;
      }
      answers[q.id] = trimmed;
      break;
    }
    if (stopped) break;
  }
  return { answers, stopped };
}

export async function briefCommandAction(opts: BriefCommandOpts): Promise<number> {
  const outPath = opts.out
    ? path.isAbsolute(opts.out)
      ? opts.out
      : path.resolve(opts.cwd, opts.out)
    : path.resolve(opts.cwd, "inputs", `${opts.name}.md`);

  if (!opts.force && (await fileExists(outPath))) {
    opts.io.stderr.write(
      `Refusing to overwrite existing file ${outPath}; pass --force to overwrite.\n`,
    );
    return 1;
  }

  if (opts.from) {
    return await runFromMode(opts, outPath);
  }

  if (opts.io.stdin.isTTY !== true) {
    opts.io.stderr.write(
      "minifac brief: interactive mode requires a TTY; use --from <file> for scripted input.\n",
    );
    return 1;
  }

  const { answers, stopped } = await runInteractive(opts);

  const haveFrontmatterBasics = !!answers.change && !!answers.factory;
  if (stopped && !haveFrontmatterBasics) {
    opts.io.stderr.write(
      "brief is missing required frontmatter (change / factory); nothing to save\n",
    );
    return 1;
  }

  const incompleteAt = computeIncompleteAt(answers);
  return await writeBriefFile(outPath, answers, incompleteAt, opts.io, opts.cwd);
}
