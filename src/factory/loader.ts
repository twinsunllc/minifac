import path from "node:path";
import {
  LibraryError,
  type LibraryPin,
  type ProjectLayout,
  loadProjectLayout,
} from "../library/library.js";
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
  /**
   * The project's pinned library, resolved to a sha, when the project
   * declares one. Recorded on the run so "which workflow ran" is answerable
   * after the fact (ADR 0039).
   */
  library?: LibraryPin;
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
 * `callerCwd` is the project root. It is used for `extends:` and `uses:`
 * lookup (local: `<callerCwd>/.minifac/`, plus root `steps/` / `workflows/`
 * in a factory repo; built-in: `<callerCwd>/examples/`), and it is where
 * the project's `library:` pin is read from (`.minifac/config.yaml` or
 * `factory.yaml`). A declared library is fetched and verified before
 * anything else resolves, so a branch or stale pin fails the load.
 */
export async function loadFactory(
  sourcePath: string,
  callerCwd: string = process.cwd(),
): Promise<LoadedFactory> {
  const absolute = path.resolve(sourcePath);
  let layout: ProjectLayout;
  try {
    layout = await loadProjectLayout(callerCwd);
  } catch (err) {
    if (err instanceof LibraryError) throw new FactoryLoadError(err.message, absolute);
    throw err;
  }
  const resolved = await resolveExtendsChain(absolute, callerCwd, layout);

  validateNodeShape(resolved.factory, absolute);
  await inlineSteps(resolved.factory, absolute, callerCwd, layout);
  validatePostSchema(resolved.factory, absolute);

  const loaded: LoadedFactory = {
    factory: resolved.factory,
    sourcePath: absolute,
    sourceDir: path.dirname(absolute),
  };
  if (layout.library !== undefined) {
    const { repo, ref, sha } = layout.library;
    loaded.library = { repo, ref, sha };
  }
  return loaded;
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
      throw new FactoryLoadError(`Node "${nodeId}" has invalid \`uses:\` value`, sourcePath);
    }
  }
}

async function inlineSteps(
  factory: Factory,
  factoryPath: string,
  callerCwd: string,
  layout: ProjectLayout,
): Promise<void> {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    const n = node as FactoryNode & { uses?: unknown; inputs?: unknown };
    if (typeof n.uses !== "string" || n.uses.length === 0) continue;
    const inlined = await inlineStepIntoNode({
      factoryPath,
      nodeId,
      node: n,
      callerCwd,
      layout,
    });
    factory.nodes[nodeId] = inlined;
  }
}

/**
 * Validate every `resume:` reference against the resolved factory.
 *
 * Three rules, all load-time (see specs/factory-schema "Node `resume:`
 * field"):
 *
 *   1. the target must be a declared node id;
 *   2. a node may not resume itself;
 *   3. the target's declared `cwd` string must match the declaring node's.
 *
 * Rule 3 is the non-obvious one: `claude` scopes sessions per project
 * directory, so a session started in one cwd is not resumable from a node
 * running in another. Comparison is on the declared (pre-substitution)
 * string — both nodes normally say `{{ run.cwd }}` — because the resolved
 * values don't exist yet at load time.
 *
 * Deliberately NOT checked: reachability. The graph is cyclic by design,
 * so "the target always runs first" isn't statically decidable; an
 * unreachable target fails at dispatch with `resume_unavailable`.
 */
function validateResume(factory: Factory, sourcePath: string, nodeIds: Set<string>): void {
  for (const [nodeId, node] of Object.entries(factory.nodes)) {
    const target = node.resume;
    if (target === undefined) continue;

    if (target === nodeId) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`resume: ${target}\`; a node cannot resume itself`,
        sourcePath,
      );
    }
    if (!nodeIds.has(target)) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`resume: ${target}\` but no node "${target}" is declared`,
        sourcePath,
      );
    }

    const targetNode = factory.nodes[target];
    const ownCwd = node.cwd;
    const targetCwd = targetNode?.cwd;
    if (ownCwd !== targetCwd) {
      throw new FactoryLoadError(
        `Node "${nodeId}" declares \`resume: ${target}\` but their \`cwd\` differs ("${nodeId}": ${describeCwd(ownCwd)}, "${target}": ${describeCwd(targetCwd)}). A resumed session is scoped to the directory it was started in.`,
        sourcePath,
      );
    }
  }
}

function describeCwd(cwd: string | undefined): string {
  return cwd === undefined ? "<unset>" : `\`${cwd}\``;
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

  validateResume(factory, sourcePath, nodeIds);

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
