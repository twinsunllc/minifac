import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { ZodError } from "zod";
import { type BriefFrontmatter, BriefFrontmatterSchema } from "./schema.js";

export interface Brief {
  frontmatter: BriefFrontmatter;
  body: string;
  sourcePath: string;
}

export class BriefLoadError extends Error {
  constructor(
    message: string,
    readonly sourcePath: string,
    readonly location?: { line: number; col?: number },
  ) {
    super(message);
    this.name = "BriefLoadError";
  }
}

function resolveBriefPath(pathOrName: string, cwd: string): string {
  const isPathLike = pathOrName.includes(path.sep) || pathOrName.endsWith(".md");
  if (isPathLike) {
    return path.isAbsolute(pathOrName) ? pathOrName : path.resolve(cwd, pathOrName);
  }
  return path.resolve(cwd, "inputs", `${pathOrName}.md`);
}

interface SplitResult {
  frontmatterText: string;
  body: string;
}

function splitFrontmatter(raw: string, sourcePath: string): SplitResult {
  // Normalize line endings to detect fences reliably.
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw new BriefLoadError(
      "Brief is missing required frontmatter (file must start with `---` on line 1)",
      sourcePath,
    );
  }
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    throw new BriefLoadError(
      "Brief frontmatter is unterminated (no closing `---` fence found)",
      sourcePath,
    );
  }
  const frontmatterText = lines.slice(1, closingIndex).join("\n");
  const bodyLines = lines.slice(closingIndex + 1);
  // Strip one optional leading newline (i.e. blank line immediately after the
  // closing fence).
  if (bodyLines.length > 0 && bodyLines[0] === "") {
    bodyLines.shift();
  }
  return { frontmatterText, body: bodyLines.join("\n") };
}

export async function loadBrief(pathOrName: string, cwd: string = process.cwd()): Promise<Brief> {
  const resolved = resolveBriefPath(pathOrName, cwd);

  let raw: string;
  try {
    raw = await readFile(resolved, "utf8");
  } catch (err) {
    throw new BriefLoadError(
      `Could not read brief file at ${resolved}: ${(err as Error).message}`,
      resolved,
    );
  }

  const { frontmatterText, body } = splitFrontmatter(raw, resolved);

  const doc = parseDocument(frontmatterText, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    if (!e) throw new BriefLoadError("YAML parse error in brief frontmatter", resolved);
    const linePos = e.linePos?.[0];
    throw new BriefLoadError(
      `YAML parse error in brief frontmatter: ${e.message}`,
      resolved,
      linePos ? { line: linePos.line, col: linePos.col } : undefined,
    );
  }

  const data = doc.toJS() ?? {};

  let frontmatter: BriefFrontmatter;
  try {
    frontmatter = BriefFrontmatterSchema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const dotted = issue ? issue.path.join(".") : "(root)";
      const detail = issue ? issue.message : "schema validation failed";
      throw new BriefLoadError(`Brief frontmatter error at ${dotted}: ${detail}`, resolved);
    }
    throw err;
  }

  return { frontmatter, body, sourcePath: resolved };
}
