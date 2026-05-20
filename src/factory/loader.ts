import path from "node:path";
import { findUncoveredCycles } from "./cycles.js";
import { resolveExtendsChain } from "./extends.js";
import { FactoryLoadError } from "./loader-error.js";
import type { Factory } from "./schema.js";

export { FactoryLoadError };

export interface LoadedFactory {
  factory: Factory;
  sourcePath: string;
  sourceDir: string;
}

/**
 * Load and validate a factory from `sourcePath`.
 *
 * If the file declares a top-level `extends:` field, the chain is resolved
 * (with the calling repo's cwd, `callerCwd`, used to locate `minifac:<name>`
 * built-ins and bare `<name>` local factories) and merged using
 * replace-at-node-level semantics. Post-schema validation runs against the
 * resolved factory; errors continue to cite the entry-point file as
 * `sourcePath` so the operator knows what to edit.
 */
export async function loadFactory(
  sourcePath: string,
  callerCwd: string = process.cwd(),
): Promise<LoadedFactory> {
  const absolute = path.resolve(sourcePath);
  const resolved = await resolveExtendsChain(absolute, callerCwd);

  validatePostSchema(resolved.factory, absolute);

  return {
    factory: resolved.factory,
    sourcePath: absolute,
    sourceDir: path.dirname(absolute),
  };
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
