import { stat } from "node:fs/promises";
import path from "node:path";
import { type ProjectLayout, describeLibrary } from "../library/library.js";
import { installRoot } from "../packaging/install-root.js";
import { StepLoadError } from "./loader-error.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SCOPE_RE = /^[a-z][a-z0-9-]*$/;

export interface ParsedStepRef {
  scope?: string;
  name: string;
  version?: string;
  /** True when the reference uses the `minifac:<name>` prefix that forces built-in resolution. */
  builtinForced: boolean;
  /** True when the reference uses the `library:<name>` prefix (the project's pinned library). */
  libraryForced?: boolean;
}

/**
 * Parse a step reference into its components. Recognized forms:
 *
 *   - `minifac:<name>[@<version>]` — built-in-only resolution
 *   - `library:<name>[@<version>]` — the project's pinned library (local override first)
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
  let libraryForced = false;
  let body = ref;
  const prefix = ref.startsWith("minifac:")
    ? "minifac:"
    : ref.startsWith("library:")
      ? "library:"
      : undefined;
  if (prefix !== undefined) {
    if (prefix === "minifac:") builtinForced = true;
    else libraryForced = true;
    body = ref.slice(prefix.length);
    if (body.length === 0) {
      throw new StepLoadError(
        `Invalid step reference \`${ref}\`: empty name after \`${prefix}\``,
        "(reference)",
      );
    }
    if (body.startsWith("/") || body.includes("/")) {
      throw new StepLoadError(
        `Invalid step reference \`${ref}\`: the \`${prefix}\` form does not accept a scope; use \`${prefix}<name>\``,
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
  } else if (parts.length === 2 && prefix === undefined) {
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
  if (libraryForced) out.libraryForced = true;
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
 * Layers, highest precedence first (ADR 0039):
 *   local    `<callerCwd>/.minifac/steps/<name>.yaml`, then — in a factory
 *            repo (a project with `factory.yaml`) — `<callerCwd>/steps/<name>.yaml`
 *   library  `<library-root>/steps/<name>.yaml`, when the project pins one
 *   built-in `<install-root>/examples/steps/<name>.yaml`, then
 *            `<callerCwd>/examples/steps/<name>.yaml` (source-tree dogfood)
 *
 * `minifac:<name>` consults only the built-in layer. `library:<name>`
 * consults local then library — a local step of the same name replaces the
 * library's wholly — and never falls through to a built-in. A bare `<name>`
 * walks all three.
 *
 * The `<scope>/<name>` form parses but is rejected at resolution as
 * reserved-for-future remote resolution (see Reference.md).
 *
 * In v0 the `@version` pin is parsed but ignored for resolution.
 */
export async function resolveStepRef(
  ref: string,
  callerCwd: string,
  layout: ProjectLayout = { factoryRepo: false },
): Promise<string> {
  const parsed = parseStepRef(ref);
  if (parsed.scope !== undefined) {
    const versionSuffix = parsed.version ? `@${parsed.version}` : "";
    throw new StepLoadError(
      `Step reference \`${parsed.scope}/${parsed.name}${versionSuffix}\` uses the scoped form (\`<scope>/<name>\`), which is reserved for future remote resolution and not yet supported. See docs/concepts/Reference.md for the planned semantics.`,
      "(reference)",
    );
  }
  const file = `${parsed.name}.yaml`;
  const builtin = [
    path.resolve(installRoot(), "examples", "steps", file),
    path.resolve(callerCwd, "examples", "steps", file),
  ];
  const local = [path.resolve(callerCwd, ".minifac", "steps", file)];
  if (layout.factoryRepo) local.push(path.resolve(callerCwd, "steps", file));
  const { library } = layout;
  const libraryPath = library === undefined ? [] : [path.resolve(library.root, "steps", file)];

  if (parsed.libraryForced && library === undefined) {
    throw new StepLoadError(
      `Step reference \`${ref}\` uses the \`library:\` namespace, but this project declares no library (add \`library: { repo, ref }\` to .minifac/config.yaml or factory.yaml)`,
      "(reference)",
    );
  }
  const candidates = parsed.builtinForced
    ? builtin
    : parsed.libraryForced
      ? [...local, ...libraryPath]
      : [...local, ...libraryPath, ...builtin];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  const where =
    parsed.libraryForced && library !== undefined
      ? ` — no step \`${parsed.name}\` in the library ${describeLibrary(library)} or the local layer`
      : "";
  throw new StepLoadError(
    `Could not resolve step reference \`${ref}\`${where} — tried ${candidates.join(", then ")}`,
    "(reference)",
  );
}
