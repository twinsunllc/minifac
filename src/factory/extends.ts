import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { ZodError } from "zod";
import { type ProjectLayout, describeLibrary } from "../library/library.js";
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

function extendsCandidates(
  ref: string,
  callerCwd: string,
  declaringFile: string,
  layout: ProjectLayout,
): string[] {
  for (const prefix of ["minifac:", "library:"] as const) {
    if (!ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    if (name.length === 0 || isPathLike(name)) {
      throw new FactoryLoadError(
        `Invalid \`extends:\` value \`${ref}\`: the name after \`${prefix}\` must be a bare identifier.`,
        declaringFile,
      );
    }
    if (prefix === "minifac:") {
      return [
        path.resolve(installRoot(), "examples", `${name}.yaml`),
        path.resolve(callerCwd, "examples", `${name}.yaml`),
      ];
    }
    // `library:<name>` reads the library only. A local workflow of the same
    // name is usually the file doing the extending (F1), so letting the local
    // layer shadow it would resolve the base to itself.
    if (layout.library === undefined) {
      throw new FactoryLoadError(
        `\`extends: ${ref}\` uses the \`library:\` namespace, but this project declares no library (add \`library: { repo, ref }\` to .minifac/config.yaml or factory.yaml)`,
        declaringFile,
      );
    }
    return [path.resolve(layout.library.root, "workflows", `${name}.yaml`)];
  }
  if (isPathLike(ref)) {
    throw new FactoryLoadError(
      `Invalid \`extends:\` value \`${ref}\`: only \`minifac:<name>\`, \`library:<name>\`, and bare \`<name>\` forms are accepted; path-like references are not allowed.`,
      declaringFile,
    );
  }
  const candidates = [path.resolve(callerCwd, ".minifac", "factories", `${ref}.yaml`)];
  if (layout.factoryRepo) candidates.push(path.resolve(callerCwd, "workflows", `${ref}.yaml`));
  if (layout.library !== undefined) {
    candidates.push(path.resolve(layout.library.root, "workflows", `${ref}.yaml`));
  }
  return candidates;
}

/**
 * Resolve an `extends:` value to an absolute path on disk.
 *
 * `minifac:<name>`:
 *   1. `<install-root>/examples/<name>.yaml` (installed package)
 *   2. `<callerCwd>/examples/<name>.yaml`    (source-tree dogfood)
 *
 * `library:<name>`: `<library-root>/workflows/<name>.yaml` only.
 *
 * Bare `<name>`: `<callerCwd>/.minifac/factories/<name>.yaml`, then — in a
 * factory repo — `<callerCwd>/workflows/<name>.yaml`, then the library's
 * `workflows/<name>.yaml` when one is pinned. The install root is NOT
 * consulted.
 */
async function resolveExtendsRef(
  ref: string,
  callerCwd: string,
  declaringFile: string,
  layout: ProjectLayout,
): Promise<string> {
  const candidates = extendsCandidates(ref, callerCwd, declaringFile, layout);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  const where =
    ref.startsWith("library:") && layout.library !== undefined
      ? ` — no workflow \`${ref.slice("library:".length)}\` in the library ${describeLibrary(layout.library)}`
      : "";
  throw new FactoryLoadError(
    `Could not resolve \`extends: ${ref}\`${where} — tried ${candidates.join(", then ")}`,
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
async function walkExtendsChain(
  entryPath: string,
  callerCwd: string,
  layout: ProjectLayout,
): Promise<ParsedLayer[]> {
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
    currentPath = await resolveExtendsRef(layer.extends, callerCwd, declaringFile, layout);
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
  layout: ProjectLayout = { factoryRepo: false },
): Promise<ResolvedFactory> {
  const absolute = path.resolve(entryPath);
  const layers = await walkExtendsChain(absolute, callerCwd, layout);
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
