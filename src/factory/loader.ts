import path from "node:path";
import { inlineStepIntoNode } from "../step/inline.js";
import { findUncoveredCycles } from "./cycles.js";
import { resolveExtendsChain } from "./extends.js";
import { FactoryLoadError } from "./loader-error.js";
import type { Factory, FactoryNode } from "./schema.js";

export { FactoryLoadError };

export interface LoadedFactory {
  factory: Factory;
  sourcePath: string;
  sourceDir: string;
}

/**
 * Load and validate a factory from `sourcePath`.
 *
 * Load pipeline (in order):
 *   1. Resolve the `extends:` chain → a single merged factory.
 *   2. Validate node-shape rules (`uses:`/`executor:` mutual exclusion etc.).
 *   3. Inline step references on every node that declared `uses:`.
 *   4. Run post-schema validation (cycles, terminal node, edge endpoints).
 *
 * `callerCwd` is used both for `extends:` lookup and for `uses:` step
 * lookup (built-in: `<callerCwd>/examples/steps/<name>.yaml`;
 * local: `<callerCwd>/.minifac/steps/<name>.yaml`).
 */
export async function loadFactory(
  sourcePath: string,
  callerCwd: string = process.cwd(),
): Promise<LoadedFactory> {
  const absolute = path.resolve(sourcePath);
  const resolved = await resolveExtendsChain(absolute, callerCwd);

  validateNodeShape(resolved.factory, absolute);
  await inlineSteps(resolved.factory, absolute, callerCwd);
  validatePostSchema(resolved.factory, absolute);

  return {
    factory: resolved.factory,
    sourcePath: absolute,
    sourceDir: path.dirname(absolute),
  };
}

/**
 * Validate the `uses:` / `executor:` / `with:` / `inputs:` interplay on
 * every node. Runs after schema parse, before step inlining.
 */
function validateNodeShape(factory: Factory, sourcePath: string): void {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    const n = node as FactoryNode & { uses?: unknown; inputs?: unknown };
    const hasUses = typeof n.uses === "string" && n.uses.length > 0;
    const hasInputs = n.inputs !== undefined;
    const hasExecutor = typeof n.executor === "string" && n.executor.length > 0;
    const hasWith = n.with !== undefined;

    if (hasUses && hasExecutor) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares both \`uses:\` and \`executor:\`; the two are mutually exclusive`,
        sourcePath,
      );
    }
    if (hasUses && hasWith) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares both \`uses:\` and \`with:\`; the two are mutually exclusive`,
        sourcePath,
      );
    }
    if (hasInputs && !hasUses) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`inputs:\` without \`uses:\`; \`inputs:\` is only valid alongside \`uses:\``,
        sourcePath,
      );
    }
    if (!hasUses && !hasExecutor) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares neither \`uses:\` nor \`executor:\`; one is required`,
        sourcePath,
      );
    }
    if (n.uses !== undefined && !hasUses) {
      // covers empty-string and non-string-after-schema (defensive)
      throw new FactoryLoadError(
        `Node "${nodeId}" has invalid \`uses:\` value`,
        sourcePath,
      );
    }
  }
}

async function inlineSteps(
  factory: Factory,
  factoryPath: string,
  callerCwd: string,
): Promise<void> {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    const n = node as FactoryNode & { uses?: unknown; inputs?: unknown };
    if (typeof n.uses !== "string" || n.uses.length === 0) continue;
    const inlined = await inlineStepIntoNode({
      factoryPath,
      nodeId,
      node: n,
      callerCwd,
    });
    factory.nodes[nodeId] = inlined;
  }
}

function validatePostSchema(factory: Factory, sourcePath: string): void {
  const nodeIds = new Set(Object.keys(factory.nodes));

  for (const edge of factory.edges) {
    if (!nodeIds.has(edge.from)) {
      throw new FactoryLoadError(
        `Edge references undeclared node "from: ${edge.from}"`,
        sourcePath,
      );
    }
    if (!nodeIds.has(edge.to)) {
      throw new FactoryLoadError(`Edge references undeclared node "to: ${edge.to}"`, sourcePath);
    }
  }

  // Start nodes are nodes with no `on_success` inbound edges. `on_failure`
  // edges are recovery flow and don't disqualify a node from being an entry
  // point for the forward flow. See specs/graph-runner/spec.md.
  const onSuccessInbound = new Set<string>();
  for (const edge of factory.edges) {
    if (edge.when === "on_success") onSuccessInbound.add(edge.to);
  }
  const startNodes = [...nodeIds].filter((id) => !onSuccessInbound.has(id));
  if (startNodes.length === 0) {
    throw new FactoryLoadError(
      "Factory has no start node (every node is the target of an `on_success` edge)",
      sourcePath,
    );
  }

  const hasTerminal = Object.values(factory.nodes).some((n) => n.terminal);
  if (!hasTerminal) {
    throw new FactoryLoadError(
      "Factory has no terminal node (mark at least one node with `terminal: true`)",
      sourcePath,
    );
  }

  const uncovered = findUncoveredCycles(factory);
  if (uncovered.length > 0) {
    const cycle = uncovered[0];
    if (cycle) {
      throw new FactoryLoadError(
        `Cycle is not covered by any budget (nodes: ${cycle.nodes.join(", ")}). Add \`max_traversals\` to an edge in the cycle, or \`max_iterations\` to a node in it.`,
        sourcePath,
      );
    }
  }
}
