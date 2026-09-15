import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { ZodError } from "zod";
import { installRoot } from "../packaging/install-root.js";
import { FactoryLoadError } from "./loader-error.js";
import { type Factory, type FactoryLayer, FactoryLayerSchema, FactorySchema } from "./schema.js";

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

interface ParsedLayer {
  layer: FactoryLayer;
  sourcePath: string;
}

function isPathLike(ref: string): boolean {
  return (
    ref.includes("/") || ref.includes(path.sep) || ref.endsWith(".yaml") || ref.endsWith(".yml")
  );
}

interface ExtendsCandidates {
  primary: string;
  fallback?: string;
}

function extendsCandidates(
  ref: string,
  callerCwd: string,
  declaringFile: string,
): ExtendsCandidates {
  if (ref.startsWith("minifac:")) {
    const name = ref.slice("minifac:".length);
    if (name.length === 0 || isPathLike(name)) {
      throw new FactoryLoadError(
        `Invalid \`extends:\` value \`${ref}\`: built-in name must be a bare identifier.`,
        declaringFile,
      );
    }
    return {
      primary: path.resolve(installRoot(), "examples", `${name}.yaml`),
      fallback: path.resolve(callerCwd, "examples", `${name}.yaml`),
    };
  }
  if (isPathLike(ref)) {
    throw new FactoryLoadError(
      `Invalid \`extends:\` value \`${ref}\`: only \`minifac:<name>\` and bare \`<name>\` forms are accepted; path-like references are not allowed.`,
      declaringFile,
    );
  }
  return { primary: path.resolve(callerCwd, ".minifac", "factories", `${ref}.yaml`) };
}

/**
 * Resolve an `extends:` value to an absolute path on disk.
 *
 * Precedence for `minifac:<name>`:
 *   1. `<install-root>/examples/<name>.yaml` (installed package)
 *   2. `<callerCwd>/examples/<name>.yaml`    (source-tree dogfood)
 *
 * Bare `<name>` references resolve only against
 * `<callerCwd>/.minifac/factories/<name>.yaml` — the install root is NOT
 * consulted.
 */
async function resolveExtendsRef(
  ref: string,
  callerCwd: string,
  declaringFile: string,
): Promise<string> {
  const { primary, fallback } = extendsCandidates(ref, callerCwd, declaringFile);
  if (await fileExists(primary)) return primary;
  if (fallback !== undefined && (await fileExists(fallback))) return fallback;
  const tried = fallback === undefined ? primary : `${primary}, then ${fallback}`;
  throw new FactoryLoadError(
    `Could not resolve \`extends: ${ref}\` — tried ${tried}`,
    declaringFile,
  );
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

    const declaringFile = layers[layers.length - 1]?.sourcePath ?? currentPath;
    currentPath = await resolveExtendsRef(layer.extends, callerCwd, declaringFile);
  }

  // Reverse to deepest-base-first.
  layers.reverse();
  return layers;
}

/**
 * A derived layer's node id that the merged base lacks is either an
 * addition or an override of a node the base does not have (a typo, or a
 * node the base renamed). The two are told apart by wiring: a node the
 * layer adds must be the endpoint of an edge the same layer declares. An
 * unwired new node is never an addition — with no inbound `on_success` edge
 * it would be inferred as a start node and dispatched when the run begins —
 * so it is a load error naming the node and the base (ADR 0008, #34).
 */
function assertNoOrphanOverride(
  layer: FactoryLayer,
  sourcePath: string,
  baseNodes: Record<string, unknown>,
  baseSourcePath: string,
): void {
  if (layer.nodes === undefined) return;
  const wired = new Set<string>();
  for (const edge of layer.edges ?? []) {
    wired.add(edge.from);
    wired.add(edge.to);
  }
  for (const nodeId of Object.keys(layer.nodes)) {
    if (Object.hasOwn(baseNodes, nodeId) || wired.has(nodeId)) continue;
    const declared = Object.keys(baseNodes).join(", ") || "(none)";
    throw new FactoryLoadError(
      `Node "${nodeId}" overrides a node that base \`${layer.extends}\` (${baseSourcePath}) does not declare (base nodes: ${declared}). To add a new node instead, wire it with an edge in this layer's \`edges:\`.`,
      sourcePath,
    );
  }
}

function mergeLayers(layers: ParsedLayer[]): unknown {
  // The deepest base provides the initial shape. Subsequent layers overlay.
  const acc: Record<string, unknown> = {};

  for (const [i, { layer, sourcePath }] of layers.entries()) {
    if (layer.name !== undefined) acc.name = layer.name;
    if (layer.description !== undefined) acc.description = layer.description;
    if (layer.brief !== undefined) acc.brief = layer.brief;

    if (layer.nodes !== undefined) {
      const baseNodes = (acc.nodes as Record<string, unknown> | undefined) ?? {};
      const base = layers[i - 1];
      if (base !== undefined) assertNoOrphanOverride(layer, sourcePath, baseNodes, base.sourcePath);
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
