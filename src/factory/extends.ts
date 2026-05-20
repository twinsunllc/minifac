import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { ZodError } from "zod";
import { FactoryLoadError } from "./loader-error.js";
import { type Factory, type FactoryLayer, FactoryLayerSchema, FactorySchema } from "./schema.js";

interface ParsedLayer {
  layer: FactoryLayer;
  sourcePath: string;
}

function isPathLike(ref: string): boolean {
  return (
    ref.includes("/") || ref.includes(path.sep) || ref.endsWith(".yaml") || ref.endsWith(".yml")
  );
}

function resolveExtendsRef(ref: string, callerCwd: string, declaringFile: string): string {
  if (ref.startsWith("minifac:")) {
    const name = ref.slice("minifac:".length);
    if (name.length === 0 || isPathLike(name)) {
      throw new FactoryLoadError(
        `Invalid \`extends:\` value \`${ref}\`: built-in name must be a bare identifier.`,
        declaringFile,
      );
    }
    return path.resolve(callerCwd, "examples", `${name}.yaml`);
  }
  if (isPathLike(ref)) {
    throw new FactoryLoadError(
      `Invalid \`extends:\` value \`${ref}\`: only \`minifac:<name>\` and bare \`<name>\` forms are accepted; path-like references are not allowed.`,
      declaringFile,
    );
  }
  return path.resolve(callerCwd, ".minifac", "factories", `${ref}.yaml`);
}

async function readAndParseLayer(absolutePath: string): Promise<FactoryLayer> {
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (err) {
    throw new FactoryLoadError(
      `Could not read factory file: ${(err as Error).message}`,
      absolutePath,
    );
  }

  const doc = parseDocument(raw, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    if (!e) throw new FactoryLoadError("YAML parse error", absolutePath);
    const linePos = e.linePos?.[0];
    throw new FactoryLoadError(
      `YAML parse error: ${e.message}`,
      absolutePath,
      linePos ? { line: linePos.line, col: linePos.col } : undefined,
    );
  }

  const data = doc.toJS();
  try {
    return FactoryLayerSchema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const dotted = issue ? issue.path.join(".") : "(root)";
      const detail = issue ? issue.message : "schema validation failed";
      throw new FactoryLoadError(`Schema error at ${dotted}: ${detail}`, absolutePath);
    }
    throw err;
  }
}

/**
 * Walk the `extends:` chain starting at `entryPath`. Returns the parsed layers
 * in deepest-base-first order (entry layer last). Throws on cycles, missing
 * base files, and invalid `extends:` values.
 */
async function walkExtendsChain(entryPath: string, callerCwd: string): Promise<ParsedLayer[]> {
  const layers: ParsedLayer[] = [];
  const visited = new Set<string>();

  let currentPath = path.resolve(entryPath);

  while (true) {
    if (visited.has(currentPath)) {
      const sequence = [...layers.map((l) => l.sourcePath), currentPath];
      throw new FactoryLoadError(
        `Cyclic \`extends:\` chain detected: ${sequence.join(" → ")}`,
        currentPath,
      );
    }
    visited.add(currentPath);

    const layer = await readAndParseLayer(currentPath);
    layers.push({ layer, sourcePath: currentPath });

    if (layer.extends === undefined) {
      break;
    }

    currentPath = resolveExtendsRef(layer.extends, callerCwd, currentPath);

    // Existence check happens implicitly when we try to read in the next loop
    // iteration. We pre-check here so the error message can name both the
    // ref and the path tried, with the *declaring file* as `sourcePath`.
    try {
      await readFile(currentPath, "utf8");
    } catch {
      const ref = layer.extends;
      throw new FactoryLoadError(
        `Could not resolve \`extends: ${ref}\` — tried ${currentPath}`,
        layers[layers.length - 1]?.sourcePath ?? currentPath,
      );
    }
  }

  // Reverse to deepest-base-first.
  layers.reverse();
  return layers;
}

function mergeLayers(layers: ParsedLayer[]): unknown {
  // The deepest base provides the initial shape. Subsequent layers overlay.
  const acc: Record<string, unknown> = {};

  for (const { layer } of layers) {
    if (layer.name !== undefined) acc.name = layer.name;
    if (layer.description !== undefined) acc.description = layer.description;
    if (layer.brief !== undefined) acc.brief = layer.brief;

    if (layer.nodes !== undefined) {
      const baseNodes = (acc.nodes as Record<string, unknown> | undefined) ?? {};
      acc.nodes = { ...baseNodes, ...layer.nodes };
    }

    if (layer.edges !== undefined) {
      // Wholesale replace when declared.
      acc.edges = layer.edges;
    }
    // No edges declared → inherit from acc unchanged.
  }

  // Ensure required fields default usefully when never declared anywhere.
  if (acc.nodes === undefined) acc.nodes = {};
  if (acc.edges === undefined) acc.edges = [];
  // `extends:` is intentionally not copied into acc.

  return acc;
}

export interface ResolvedFactory {
  factory: Factory;
  entryPath: string;
  chain: string[];
}

/**
 * Read the entry-point factory file, follow `extends:` references, and
 * return the merged factory along with the chain that produced it.
 *
 * The returned `factory` has been validated through the strict `FactorySchema`
 * and has no `extends:` field. Post-schema validation (cycles, terminal node,
 * etc.) is the caller's responsibility.
 */
export async function resolveExtendsChain(
  entryPath: string,
  callerCwd: string,
): Promise<ResolvedFactory> {
  const absolute = path.resolve(entryPath);
  const layers = await walkExtendsChain(absolute, callerCwd);
  const merged = mergeLayers(layers);

  let factory: Factory;
  try {
    factory = FactorySchema.parse(merged);
  } catch (err) {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const dotted = issue ? issue.path.join(".") : "(root)";
      const detail = issue ? issue.message : "schema validation failed";
      throw new FactoryLoadError(`Schema error at ${dotted}: ${detail}`, absolute);
    }
    throw err;
  }

  return {
    factory,
    entryPath: absolute,
    chain: layers.map((l) => l.sourcePath),
  };
}
