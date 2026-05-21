import { stat } from "node:fs/promises";
import path from "node:path";
import { StepLoadError } from "./loader-error.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCOPE_RE = /^[a-z][a-z0-9-]*$/;

export interface ParsedStepRef {
  scope?: string;
  name: string;
  version?: string;
  /** True when the reference uses the `minifac:<name>` prefix that forces built-in resolution. */
  builtinForced: boolean;
}

/**
 * Parse a step reference into its components. Recognized forms:
 *
 *   - `minifac:<name>[@<version>]` — built-in-only resolution
 *   - `<scope>/<name>[@<version>]` — namespaced (local-first lookup in v0)
 *   - `<name>[@<version>]`         — bare (local-first lookup, falls back to built-in)
 *
 * Throws if the value contains whitespace, multiple slashes, a file
 * extension, an empty pin, etc.
 */
export function parseStepRef(ref: string): ParsedStepRef {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new StepLoadError("Invalid step reference: value is empty", "(reference)");
  }
  if (/\s/.test(ref)) {
    throw new StepLoadError(
      `Invalid step reference \`${ref}\`: contains whitespace`,
      "(reference)",
    );
  }
  if (ref.endsWith(".yaml") || ref.endsWith(".yml")) {
    throw new StepLoadError(
      `Invalid step reference \`${ref}\`: file extensions are not accepted`,
      "(reference)",
    );
  }
  if (ref.includes("\\")) {
    throw new StepLoadError(
      `Invalid step reference \`${ref}\`: path separators are not allowed`,
      "(reference)",
    );
  }

  let builtinForced = false;
  let body = ref;
  if (ref.startsWith("minifac:")) {
    builtinForced = true;
    body = ref.slice("minifac:".length);
    if (body.length === 0) {
      throw new StepLoadError(
        `Invalid step reference \`${ref}\`: empty name after \`minifac:\``,
        "(reference)",
      );
    }
    if (body.startsWith("/") || body.includes("/")) {
      throw new StepLoadError(
        `Invalid step reference \`${ref}\`: built-in form (\`minifac:\`) does not accept a scope; use \`minifac:<name>\``,
        "(reference)",
      );
    }
  }

  // Strip @version pin
  let version: string | undefined;
  const atIdx = body.indexOf("@");
  if (atIdx >= 0) {
    version = body.slice(atIdx + 1);
    body = body.slice(0, atIdx);
    if (version.length === 0) {
      throw new StepLoadError(
        `Invalid step reference \`${ref}\`: empty version pin after \`@\``,
        "(reference)",
      );
    }
    if (/\s/.test(version)) {
      throw new StepLoadError(
        `Invalid step reference \`${ref}\`: version pin contains whitespace`,
        "(reference)",
      );
    }
  }

  // Split scope/name
  let scope: string | undefined;
  let name: string;
  const parts = body.split("/");
  if (parts.length === 1) {
    name = parts[0] ?? "";
  } else if (parts.length === 2 && !builtinForced) {
    scope = parts[0] ?? "";
    name = parts[1] ?? "";
    if (!SCOPE_RE.test(scope)) {
      throw new StepLoadError(
        `Invalid step reference \`${ref}\`: scope \`${scope}\` must match [a-z][a-z0-9-]*`,
        "(reference)",
      );
    }
  } else {
    throw new StepLoadError(
      `Invalid step reference \`${ref}\`: only \`minifac:<name>\`, \`<scope>/<name>\`, or bare \`<name>\` forms are accepted`,
      "(reference)",
    );
  }

  if (name.length === 0) {
    throw new StepLoadError(`Invalid step reference \`${ref}\`: empty step name`, "(reference)");
  }
  if (!NAME_RE.test(name)) {
    throw new StepLoadError(
      `Invalid step reference \`${ref}\`: name \`${name}\` must match [a-z][a-z0-9-]*`,
      "(reference)",
    );
  }

  const out: ParsedStepRef = { name, builtinForced };
  if (scope !== undefined) out.scope = scope;
  if (version !== undefined) out.version = version;
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a step reference to an absolute path on disk. Returns the path
 * of the existing file. Throws `StepLoadError` with all candidate paths in
 * the message when nothing resolves.
 *
 * In v0 the `@version` pin is parsed but ignored for resolution.
 */
export async function resolveStepRef(ref: string, callerCwd: string): Promise<string> {
  const parsed = parseStepRef(ref);
  const builtin = path.resolve(callerCwd, "examples", "steps", `${parsed.name}.yaml`);
  if (parsed.builtinForced) {
    if (await fileExists(builtin)) return builtin;
    throw new StepLoadError(
      `Could not resolve step reference \`${ref}\` — tried ${builtin}`,
      "(reference)",
    );
  }
  const local = path.resolve(callerCwd, ".minifac", "steps", `${parsed.name}.yaml`);
  if (await fileExists(local)) return local;
  if (await fileExists(builtin)) return builtin;
  throw new StepLoadError(
    `Could not resolve step reference \`${ref}\` — tried ${local}, then ${builtin}`,
    "(reference)",
  );
}
