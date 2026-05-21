import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { ZodError } from "zod";
import { StepLoadError } from "./loader-error.js";
import { type Step, StepSchema } from "./schema.js";

export { StepLoadError };

export interface LoadedStep {
  step: Step;
  sourcePath: string;
}

/**
 * Read, parse, and validate a step YAML file at `absPath`.
 */
export async function loadStep(absPath: string): Promise<LoadedStep> {
  const absolute = path.resolve(absPath);
  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (err) {
    throw new StepLoadError(
      `Could not read step file: ${(err as Error).message}`,
      absolute,
    );
  }

  const doc = parseDocument(raw, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    if (!e) throw new StepLoadError("YAML parse error", absolute);
    const linePos = e.linePos?.[0];
    throw new StepLoadError(
      `YAML parse error: ${e.message}`,
      absolute,
      linePos ? { line: linePos.line, col: linePos.col } : undefined,
    );
  }

  const data = doc.toJS();
  try {
    const step = StepSchema.parse(data);
    return { step, sourcePath: absolute };
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const dotted = issue ? issue.path.join(".") : "(root)";
      const detail = issue ? issue.message : "schema validation failed";
      throw new StepLoadError(
        `Schema error at ${dotted}: ${detail}`,
        absolute,
      );
    }
    throw err;
  }
}
